#!/usr/bin/env python3
"""OSS 发布工具：GitHub Actions OIDC → STS 临时凭证 → 上传。

零长期密钥：用 runner 注入的 OIDC Token 向阿里云换取 1 小时 STS 凭证
（AssumeRoleWithOIDC 为匿名 RPC 接口，无需签名），再用 oss2 上传。
只能在 GitHub Actions 里运行（依赖 ACTIONS_ID_TOKEN_* 环境变量）。

用法（子命令）：
  notice <version> <gray>   写 updates/notice.json（灰度控制）
  latest <file>             上传 updates/latest.json（updater 元数据）
  notes  <version> <file>   上传 updates/releases/v<version>.md（更新说明）
  verify <key>              校验对象存在且可匿名读取
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

OSS_BUCKET = os.environ.get("OSS_BUCKET", "openhoyo-updates")
OSS_REGION = os.environ.get("OSS_REGION", "cn-hangzhou")
ROLE_ARN = os.environ["ROLE_ARN"]
OIDC_PROVIDER_ARN = os.environ["OIDC_PROVIDER_ARN"]


def die(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def fetch_oidc_token() -> str:
    """从 runner 环境换取 GitHub OIDC Token（audience 为阿里云固定要求值）"""
    import base64

    url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not url or not token:
        die("缺少 ACTIONS_ID_TOKEN_* 环境变量（需要 permissions: id-token: write）")
    req = urllib.request.Request(
        f"{url}&audience=sts.amazonaws.com",
        headers={"Authorization": f"bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        value = json.load(resp)["value"]
    # 调试：打印 claims（不含签名，token 数分钟过期）用于对照信任策略
    payload = value.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
    print(f"OIDC claims: iss={claims.get('iss')} aud={claims.get('aud')} sub={claims.get('sub')}")
    return value


def assume_sts(oidc_token: str):
    """AssumeRoleWithOIDC（免签名的匿名 RPC 接口，但公共参数仍必填）换取 1 小时 STS 凭证"""
    import datetime
    import uuid

    form = urllib.parse.urlencode(
        {
            "Action": "AssumeRoleWithOIDC",
            "Version": "2015-04-01",
            "Format": "JSON",
            "SignatureMethod": "HMAC-SHA1",
            "SignatureVersion": "1.0",
            "SignatureNonce": uuid.uuid4().hex,
            "Timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "RoleArn": ROLE_ARN,
            "OIDCProviderArn": OIDC_PROVIDER_ARN,
            "OIDCToken": oidc_token,
            "RoleSessionName": "github-actions-openhoyo",
        }
    ).encode()
    req = urllib.request.Request(
        f"https://sts.{OSS_REGION}.aliyuncs.com/",
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        die(f"AssumeRoleWithOIDC HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:2000]}")
    creds = data["Credentials"]
    return creds["AccessKeyId"], creds["AccessKeySecret"], creds["SecurityToken"]


def open_bucket():
    import oss2

    ak, sk, token = assume_sts(fetch_oidc_token())
    auth = oss2.StsAuth(ak, sk, token)
    return oss2.Bucket(auth, f"https://oss-{OSS_REGION}.aliyuncs.com", OSS_BUCKET)


def put(key: str, data: bytes, content_type: str) -> None:
    bucket = open_bucket()
    bucket.put_object(key, data, headers={"Content-Type": content_type})
    public_url = f"https://{OSS_BUCKET}.oss-{OSS_REGION}.aliyuncs.com/{key}"
    print(f"✓ 已上传 {key} ({len(data)}B) → {public_url}")


def main() -> None:
    if len(sys.argv) < 2:
        die(f"用法: {sys.argv[0]} notice|latest|notes|verify ...")

    mode = sys.argv[1]
    if mode == "notice":
        version, gray = sys.argv[2], sys.argv[3]
        body = json.dumps({"version": version, "gray": int(gray)}, ensure_ascii=False).encode()
        put("updates/notice.json", body, "application/json")
    elif mode == "latest":
        with open(sys.argv[2], "rb") as f:
            put("updates/latest.json", f.read(), "application/json")
    elif mode == "notes":
        version = sys.argv[2]
        with open(sys.argv[3], "rb") as f:
            put(f"updates/releases/v{version}.md", f.read(), "text/markdown")
    elif mode == "verify":
        key = sys.argv[2]
        url = f"https://{OSS_BUCKET}.oss-{OSS_REGION}.aliyuncs.com/{urllib.parse.quote(key)}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
        print(f"✓ {key} 可匿名读取 ({len(data)}B)")
    else:
        die(f"未知子命令: {mode}")


if __name__ == "__main__":
    main()
