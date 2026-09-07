#!/usr/bin/env python3
"""CNB Release 上传（api.cnb.cool，国内免费下载源）。

用法: cnb-release.py <tag> <title> <body_file> <asset_file>...
最后一行输出资产下载 URL（供 latest.json 拼接）。

环境变量：
  CNB_TOKEN  个人访问令牌（GitHub Secret 注入）
  CNB_REPO   仓库路径，默认 openhoyo/openhoyo-release
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://api.cnb.cool"
TOKEN = os.environ["CNB_TOKEN"]
REPO = os.environ.get("CNB_REPO", "openhoyo/openhoyo-release")


def die(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def api(method: str, path: str, data=None, raw=None, content_type="application/json"):
    body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(BASE + path, data=body, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if body is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        die(f"CNB API {method} {path} → HTTP {e.code}: {detail[:300]}")
    return json.loads(payload) if payload else {}


def find_release_id(tag: str) -> str:
    try:
        release = api("GET", f"/{REPO}/-/releases/tags/{tag}")
        return release["id"]
    except SystemExit:
        raise
    except Exception:
        return ""


def create_or_get_release(tag: str, title: str, body: str) -> str:
    existing = find_release_id(tag)
    if existing:
        print(f"release {tag} 已存在，复用 {existing}")
        return existing
    release = api(
        "POST",
        f"/{REPO}/-/releases",
        {
            "tag_name": tag,
            "name": title,
            "body": body,
            "draft": False,
            "prerelease": False,
            "make_latest": "true",
        },
    )
    print(f"✓ 创建 release {tag}（{release['id']}）")
    return release["id"]


def upload_asset(release_id: str, tag: str, path: str) -> str:
    name = os.path.basename(path)
    info = api("GET", f"/{REPO}/-/releases/{release_id}/asset-upload-url?name={name}")
    upload_url = info.get("upload_url")
    if not upload_url:
        die(f"未取得 {name} 的上传地址: {json.dumps(info)[:200]}")
    with open(path, "rb") as f:
        raw = f.read()
    req = urllib.request.Request(upload_url, data=raw, method="PUT")
    req.add_header("Content-Type", "application/octet-stream")
    with urllib.request.urlopen(req, timeout=600) as resp:
        resp.read()
    url = f"https://cnb.cool/{REPO}/-/releases/download/{tag}/{name}"
    print(f"✓ 上传 {name}（{len(raw)}B）→ {url}")
    return url


def main() -> None:
    if len(sys.argv) < 5:
        die("用法: cnb-release.py <tag> <title> <body_file> <asset_file>...")
    tag, title, body_file = sys.argv[1], sys.argv[2], sys.argv[3]
    assets = sys.argv[4:]

    with open(body_file, "rb") as f:
        body = f.read().decode("utf-8")

    release_id = create_or_get_release(tag, title, body)
    urls = [upload_asset(release_id, tag, asset) for asset in assets]
    for url in urls:
        print(f"ASSET_URL={url}")


if __name__ == "__main__":
    main()
