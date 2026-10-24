#!/usr/bin/env python3
"""统一发布更新数据：CNB 主源、GitHub 备用、OSS 旧客户端兼容。仅在 CI 中执行写入。"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


cnb = module("cnb_release", "cnb-release.py")
GITHUB_REPO = os.environ.get("GITHUB_REPOSITORY", "icimence/OpenHoyo")
OSS_BASE = "https://openhoyo-updates.oss-cn-hangzhou.aliyuncs.com/updates"


def version_tuple(version):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("版本号必须是 x.y.z")
    return tuple(map(int, version.split(".")))


def read_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "OpenHoyo-Publisher", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def latest_release():
    try:
        return cnb.api("GET", f"/{cnb.REPO}/-/releases/latest")
    except cnb.CnbApiError as error:
        if error.code == 404:
            return None
        raise


def check_target(version, *, exact=False):
    target = version_tuple(version)
    live = latest_release()
    if live:
        current = live["tag_name"].removeprefix("v")
        if (exact and current != version) or version_tuple(current) > target:
            raise ValueError(f"CNB 最新版本为 v{current}，拒绝将当前更新入口改成 v{version}")
    elif exact:
        raise ValueError("CNB 尚无已发布版本")
    return live


def github(*args):
    subprocess.run(["gh", *args, "--repo", GITHUB_REPO], check=True)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def github_notice(notice):
    backup = copy.deepcopy(notice)
    if backup.get("android"):
        version = backup["version"]
        name = urllib.parse.unquote(urllib.parse.urlsplit(backup["android"]["url"]).path.rsplit("/", 1)[-1])
        backup["android"]["url"] = f"https://github.com/{GITHUB_REPO}/releases/download/v{version}/{urllib.parse.quote(name, safe='')}"
    return backup


def installer_name(manifest):
    # productName 改名后安装包名称也会变；使用签名清单中的真实附件名，兼容历史品牌。
    names = set()
    for url in {platform.get("url", "") for platform in manifest.get("platforms", {}).values()}:
        # tauri-action v1 可能写入 GitHub API 附件编号，而非公开文件名地址。
        # 只向当前仓库的官方 GitHub API 查询，获取实际附件名后再构建国内/备用下载地址。
        prefix = f"https://api.github.com/repos/{GITHUB_REPO}/releases/assets/"
        if url.startswith(prefix) and url[len(prefix):].isdigit():
            asset = json.loads(subprocess.check_output(["gh", "api", url[len("https://api.github.com/"):]], text=True))
            name = asset.get("name", "")
        else:
            name = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1])
        names.add(name)
    if len(names) != 1:
        raise ValueError("Windows 平台安装包名称不一致")
    name = names.pop()
    if not name.endswith("_x64-setup.exe") or "/" in name or "\\" in name:
        raise ValueError("更新清单中的 Windows 安装包名称无效")
    return name


def metadata(version, manifest, notes, android=False):
    version_tuple(version)
    notes = notes.strip()
    if not notes:
        raise ValueError("拒绝发布空白更新说明")
    if manifest.get("version") != version or not manifest.get("platforms"):
        raise ValueError("更新清单版本不匹配或缺少平台")
    domestic, backup = copy.deepcopy(manifest), copy.deepcopy(manifest)
    domestic["notes"] = backup["notes"] = notes
    installer = installer_name(manifest)
    for source, url in [(domestic, cnb.asset_url(f"v{version}", installer)),
                        (backup, f"https://github.com/{GITHUB_REPO}/releases/download/v{version}/{urllib.parse.quote(installer, safe='')}")]:
        for platform in source["platforms"].values():
            if not platform.get("signature"):
                raise ValueError("更新清单缺少安装包签名")
            platform["url"] = url
    notice = {"version": version, "gray": 0}
    if android:
        apk_name = android if isinstance(android, str) else f"hoyo-auth_{version}_android-arm64.apk"
        notice["android"] = {"url": cnb.asset_url(f"v{version}", apk_name)}
    return domestic, backup, notice


def verify_assets(tag, files):
    # CNB 附件会经过重定向和分发；读取内容做校验，不能只判断“HTTP 200”。
    for file in files:
        expected = file.read_bytes()
        for attempt in range(6):
            try:
                request = urllib.request.Request(cnb.asset_url(tag, file.name), headers={"Cache-Control": "no-cache"})
                with urllib.request.urlopen(request, timeout=20) as response:
                    actual = response.read()
                if actual == expected:
                    print(f"✓ CNB {tag}/{file.name} 已公开且内容一致")
                    break
            except (urllib.error.URLError, TimeoutError):
                pass
            if attempt == 5:
                raise ValueError(f"CNB {tag}/{file.name} 未能通过公开读取校验")
            time.sleep(2 ** attempt)


def mirror_oss(version, *, manifest=None, notice=None, notes=None):
    # 用户尚未授权移除这条兼容链路：沿用 OIDC→STS，无长期阿里云密钥。
    oss = module("oss_publish", "oss-sts-publish.py")
    keys = []
    if notes is not None:
        key = f"updates/releases/v{version}.md"
        oss.put(key, (notes.strip() + "\n").encode(), "text/markdown")
        keys.append(key)
    for key, data in [("updates/latest.json", manifest), ("updates/notice.json", notice)]:
        if data is not None:
            oss.put(key, json.dumps(data, ensure_ascii=False).encode(), "application/json")
            keys.append(key)
    for key in keys:
        oss.verify(key)


def upload_metadata(release_id, tag, directory, values):
    files = []
    for name, value in values.items():
        file = directory / name
        if name.endswith(".json"):
            write_json(file, value)
        else:
            file.write_text(value.strip() + "\n", encoding="utf-8")
        cnb.upload_asset(release_id, tag, str(file))
        files.append(file)
    return files


def publish_release(version, directory):
    tag = f"v{version}"
    notes = (directory / "notes.md").read_text(encoding="utf-8").strip()
    manifest = json.loads((directory / "latest.json").read_text(encoding="utf-8"))
    installer = directory / installer_name(manifest)
    if not installer.is_file():
        raise ValueError("缺少 Windows 安装包")
    apks = list(directory.glob("*_android-arm64.apk"))
    if len(apks) > 1:
        raise ValueError("目录中存在多个安卓安装包，无法确定目标")
    apk = apks[0] if apks else None
    domestic, backup, notice = metadata(version, manifest, notes, apk.name if apk else False)
    check_target(version)
    release_id = cnb.create_or_get_release(tag, f"霜舞工具箱 FrostDance {tag}", notes)
    for file in [installer, *([apk] if apk else [])]:
        cnb.upload_asset(release_id, tag, str(file))
    with tempfile.TemporaryDirectory() as temp:
        work = Path(temp)
        files = upload_metadata(release_id, tag, work, {"latest.json": domestic, "notice.json": notice, "notes.md": notes})
        # GitHub 的备用清单保留 GitHub 安装包地址，CNB 故障时仍能完成下载。
        github_dir = work / "github"
        backup_file = write_json(github_dir / "latest.json", backup)
        backup_notice = write_json(github_dir / "notice.json", github_notice(notice))
        github("release", "upload", tag, str(backup_file), str(backup_notice), str(work / "notes.md"), "--clobber")
        github("release", "edit", tag, "--notes-file", str(work / "notes.md"))
        mirror_oss(version, manifest=domestic, notice=notice, notes=notes)
        cnb.api("PATCH", f"/{cnb.REPO}/-/releases/{release_id}", {"draft": False, "make_latest": "false"})
        verify_assets(tag, files)
        # 全部资产、说明、备用源和旧客户端兼容数据均就绪后，才切换国内主入口。
        cnb.api("PATCH", f"/{cnb.REPO}/-/releases/{release_id}", {"make_latest": "true"})


def update_gray(version, gray):
    if not 0 <= gray <= 10:
        raise ValueError("gray 必须为 0~10")
    live = check_target(version, exact=True)
    tag = f"v{version}"
    try:
        notice = read_json(cnb.asset_url(tag, "notice.json"))
    except urllib.error.HTTPError as error:
        # 兼容迁移前发布的版本，它们的 CNB Release 尚没有 notice 附件。
        if error.code != 404:
            raise
        notice = read_json(f"{OSS_BASE}/notice.json")
    if notice.get("version") != version:
        raise ValueError("版本通告与目标版本不一致，拒绝丢弃安卓地址或改写其它版本")
    notice["gray"] = gray
    with tempfile.TemporaryDirectory() as temp:
        files = upload_metadata(live["id"], tag, Path(temp), {"notice.json": notice})
        backup_file = write_json(Path(temp) / "github" / "notice.json", github_notice(notice))
        github("release", "upload", tag, str(backup_file), "--clobber")
        mirror_oss(version, notice=notice)
        verify_assets(tag, files)


def publish_notes(version, notes_file):
    version_tuple(version)
    notes = notes_file.read_text(encoding="utf-8").strip()
    if not notes:
        raise ValueError("拒绝发布空白更新说明")
    tag = f"v{version}"
    release_id = cnb.find_release_id(tag)
    if not release_id:
        raise ValueError(f"CNB {tag} 不存在")
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        github("release", "download", tag, "--pattern", "latest.json", "--dir", str(directory))
        manifest = json.loads((directory / "latest.json").read_text(encoding="utf-8"))
        domestic, backup, _ = metadata(version, manifest, notes)
        files = upload_metadata(release_id, tag, directory, {"notes.md": notes, "latest.json": domestic})
        cnb.api("PATCH", f"/{cnb.REPO}/-/releases/{release_id}", {"body": notes})
        backup_file = write_json(directory / "github" / "latest.json", backup)
        github("release", "upload", tag, str(backup_file), str(directory / "notes.md"), "--clobber")
        github("release", "edit", tag, "--notes-file", str(directory / "notes.md"))
        # 历史版本可以补说明，但不能把线上 latest 降回旧版本。
        current = read_json(f"{OSS_BASE}/latest.json")
        mirror_oss(version, manifest=domestic if current.get("version") == version else None, notes=notes)
        verify_assets(tag, files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["release", "gray", "notes"]:
        command = commands.add_parser(name)
        command.add_argument("version")
        if name == "release":
            command.add_argument("directory", type=Path)
        elif name == "gray":
            command.add_argument("gray", type=int)
        else:
            command.add_argument("notes_file", type=Path)
    args = parser.parse_args()
    version_tuple(args.version)
    if args.command == "release":
        publish_release(args.version, args.directory)
    elif args.command == "gray":
        update_gray(args.version, args.gray)
    else:
        publish_notes(args.version, args.notes_file)


if __name__ == "__main__":
    main()
