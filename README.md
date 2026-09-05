# HoyoAuth

基于 **Tauri 2** 重制的米哈游账号登录示例，移植自 [SnapHutaoArchive](https://github.com/icimence/SnapHutaoArchive)（Snap Hutao 存档）的米哈游账号体系，**只实现用户登录与凭证管理**，其余功能一概不做。

> 仅供学习与交流。米哈游相关接口与 salt 均来自原开源项目及社区公开资料。

## 功能

- **扫码登录**（国服）：伪装 HoyoPlay 启动器调用 `createQRLogin` / `queryQRLoginStatus`，本地渲染二维码，3 秒轮询，过期自动刷新
- **手机验证码登录**（国服）：手机号 RSA 加密 + DS Gen2 签名（触发极验风控时会提示改用扫码）
- **Cookie 导入**（国服/国际服）：粘贴含 `stuid/mid/stoken` 的 Cookie
- **完整凭证初始化链**（对应原版 `InitializeUserAsync` 五步）：
  `SToken → LToken → cookie_token → 用户信息 → 游戏角色列表 → 设备指纹`
- **凭证懒刷新**：启动时自动恢复用户；cookie_token 超 1 天、设备指纹超 7 天自动用 SToken 重换
- **SQLite 持久化**：users 表存三组 Cookie + 刷新时间戳（`%APPDATA%/com.learnrepo.hoyoauth/users.db`）
- **运行时 salt 刷新**：启动时尽力从原版同源端点拉取最新 salt/版本，失败则使用内置默认值

## 开发

```bash
npm install
npm run tauri dev
```

发布构建：

```bash
npm run tauri build
```

> 如遇 cargo 下载 crates 报证书吊销错误（schannel 企业网络问题），本项目已在
> `src-tauri/.cargo/config.toml` 中设置 `check-revoke = false`。

## 架构与原版对照

| 本项目 (Rust) | 原 Snap.Hutao (C#) |
|---|---|
| `src-tauri/src/constants.rs` | `HoyolabOptions` / `ApiEndpoints.csv` / `SaltConstants`(源生成器) |
| `src-tauri/src/cookie.rs` | `Web/Hoyolab/Cookie(.Constant/.Extension).cs` |
| `src-tauri/src/ds.rs` | `DataSigning/*` |
| `src-tauri/src/http.rs` | `HttpClientConfiguration` XRpc2/3/5/6 + `HoyolabHttpRequestMessageBuilderExtension` |
| `src-tauri/src/passport.rs` | `PassportClient` / `HoyoPlayPassportClient` |
| `src-tauri/src/user_api.rs` | `UserClient` / `BindingClient` / `AuthClient` |
| `src-tauri/src/device_fp.rs` | `UserFingerprintService` / `DeviceFpClient` |
| `src-tauri/src/store.rs` | `Model/Entity/User` + `UserRepository` |
| `src-tauri/src/service.rs` | `UserService` / `UserInitializationService` / `UserCollectionService` |
| `src/main.ts` + `src/ui.ts` | `UserViewModel` + `UserQRCodeDialog` / `UserMobileCaptchaDialog` / `UserDialog` |

### 凭证模型

```
登录（扫码/验证码/Cookie 导入）
        ↓  stuid + mid + stoken
      SToken ──────────────── 根凭证，唯一需要"登录"获得
        ├─ ltoken            缺失时兑换
        ├─ cookie_token      超 1 天自动重换
        ├─ actionTicket      查询游戏角色时现换（DS Gen1 + K2 签名）
        └─ device_fp         伪造安卓设备信息兑换，超 7 天重换
```

## 已知限制（v1 有意为之）

- 国际服仅支持 Cookie 导入（密码/三方登录涉及 WebView 风控组件，未实现）
- 极验（Aigis）验证码组件未实现，验证码登录触发风控时提示改用扫码
- 指纹接口失败不阻塞登录（与原版尽力而为语义一致）

## 自动更新与发布（v0.2+）

### 更新分发链路

```
release.yml (tag 触发) ─→ tauri-action 构建 + 私钥签名 ─→ GitHub Release
                                                                    │
App 启动 5 秒后静默检查 ← latest.json + 签名安装包 ←────────────────┘
（用户菜单"检查更新"可手动触发）→ 弹升级对话框 → 下载(带进度) → 自动重启
```

### 发布新版本

1. 本地 `node scripts/bump-version.mjs 0.2.0` 或直接推标签 `git tag v0.2.0 && git push --tags`
2. Actions 自动构建 NSIS 安装包、用 updater 私钥签名、创建 Release 并生成 `latest.json`
3. 已安装用户启动 App 即收到新版本提示

### 必须的仓库配置（一次性）

- **Secrets → Actions** 添加：
  - `TAURI_SIGNING_PRIVATE_KEY`：`scripts/hoyo-auth-updater.key` 文件全部内容（私钥，已 gitignore，**请自行备份，丢失将无法再推送更新**）
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：空字符串（本项目密钥未设密码）
- **`src-tauri/tauri.conf.json`** 的 `plugins.updater.endpoints` 需改为你的实际仓库地址（当前为 `icimence/OpenHoyo`）

### 数据维护节奏

| 数据 | 来源 | Action | 频率 |
|---|---|---|---|
| 卡池事件 + 物品名称 | Snap.Metadata 镜像 | update-banners.yml | 每日 |
| 角色/武器图标 | 米哈游官方观测枢 wiki | update-icons.yml | 每两周（版本周期 42 天） |

米哈游版本节奏约 6 周（42 天）一个版本；新卡池数据在上游开池后 2~5 天内可用。
