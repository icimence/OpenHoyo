# 更新分发与旧客户端兼容

新客户端读取 CNB Release 的公开附件，GitHub 为备用，OSS 为迁移兼容源。
安装包继续由 GitHub Actions 构建；CNB 访问令牌仅用于工作流，不进入客户端。

| 数据 | CNB | GitHub | OSS（旧客户端） |
| --- | --- | --- | --- |
| 当前版本与灰度 | 最新 Release 的 `notice.json` | 最新 Release 的 `notice.json` | `updates/notice.json` |
| 桌面更新清单 | 最新 Release 的 `latest.json`，安装包指向 CNB | 最新 Release 的 `latest.json`，安装包指向 GitHub | `updates/latest.json`，安装包指向 CNB |
| 指定版本说明 | `vX.Y.Z` 的 `notes.md` 与发布正文 | `vX.Y.Z` 的 `notes.md` 与发布正文 | `updates/releases/vX.Y.Z.md` |

CNB 最新附件地址形如 `https://cnb.cool/openhoyo/openhoyo-release/-/releases/latest/download/notice.json`。
指定版本附件地址形如 `https://cnb.cool/openhoyo/openhoyo-release/-/releases/download/v0.1.15/notes.md`。
迁移前的版本没有这些附件时，客户端继续回退 OSS 和旧 GitHub 发布正文。

## 发版与日常维护

- `release.yml`：发版前生成非空说明并保存为构建产物；Windows、Android 和分发固定使用同一提交。
  `publish-update.py release` 上传安装包与三类元数据，保留签名，发布初始灰度为 0。
  只有 GitHub 备用和 OSS 兼容数据均写入成功、CNB 附件公开读取内容一致后，才将 CNB 版本设为 latest。
- `update-gray.yml`：`publish-update.py gray` 校验目标为当前最新版本，同步三源的灰度，保留安卓地址；
  GitHub 备用通告的安卓地址指向 GitHub，CNB 与 OSS 通告指向 CNB。
- `publish-release-notes.yml`：从 `CHANGELOG.md` 提取非空说明，同步三源说明与 CNB/GitHub 正文。
  可以修订历史版本；只在 OSS 当前版本等于目标版本时覆盖它的 `latest.json`。
- 以上工作流使用同一并发组排队，避免放量、改说明与发版交错覆盖。

自动卡池发布会先运行 `compose-release-notes.mjs --record`，把对应上/下半卡池角色信息写入
`CHANGELOG.md` 并随卡池数据提交。正式发版再次提取，全部渠道使用相同文案。
手动发版缺少段落时使用固定用户文案，任何情况下都不能发布空白说明。

## v0.1.11 空白说明的原因

当时没有 `## v0.1.11` 段落，提取脚本用 `console.log("")` 输出了一个换行。
工作流的 `-s` 只检查文件字节数，误判为存在说明，跳过兜底并成功发布空正文。
提取脚本现在缺失时输出零字节，统一生成器按 `trim()` 判断，分发脚本再做非空校验。
启动弹窗也只在用户确认阅读后记为已读；网络失败或空说明会在下次启动重试。

## OSS 停用边界

用户尚未要求移除 OSS。继续保留三个原始对象路径、原始数据结构、OIDC→STS 发布权限、
灰度与说明同步，确保 v0.1.14 及更早客户端仍可升级。只在用户明确通知后规划移除。

本次代码开发不触发发版，也不自动修订线上历史 Release。
若要补发 v0.1.11 说明，合并后运行 `publish-release-notes.yml`，版本填 `0.1.11`，无需重新构建安装包。

## 本地验证

```text
node --test scripts/release-notes.test.mjs scripts/validate-gacha-icons.test.mjs src/html.test.mjs src/gacha-combined.test.mjs
python -m unittest discover -s scripts -p test_publish_update.py
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

分发测试使用模拟 CNB、GitHub 和 OSS 调用，不需要发布凭证，不写入线上数据。
