# OpenHoyo

基于 Tauri 2 的原神工具箱，参考 [Snap Hutao Remastered](https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered) 的本地功能与交互。项目供学习与交流。

## 已实现的功能

- 米哈游账号的扫码、手机验证码和 Cookie 登录；凭证恢复与懒刷新
- 祈愿记录的刷新、总览、活动期历史、角色与武器统计、UP 计时、UIGF v4.x 导入导出
- 实时便笺、我的角色，以及深境螺旋、幻想真境剧诗、幽境危战的周期记录
- 设置、反馈中心、自动更新

全球祈愿统计、颂愿和胡桃云不在复刻范围内。侧边栏中的部分入口仍为占位。

## 开发与验证

需要 Node.js、Rust 工具链和 Windows WebView2。

```bash
npm install
npm run tauri dev
```

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

UIGF 导入会在后台按批写入 SQLite，并向前端发送 `uigf://progress` 事件。相同文件重复导入时，已有记录自动跳过。真实文件的往返验证可运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib uigf_roundtrip_real_file -- --ignored --nocapture
```

该测试默认读取桌面的 `Snap Hutao UIGF.json`，也可设置 `UIGF_SAMPLE` 指向其他文件；测试数据库建在系统临时目录，不会修改应用数据。

## 代码结构

| 模块 | 职责 |
| --- | --- |
| `src/main.ts`、`src/ui.ts` | 导航、通用对话框与提示 |
| `src/gacha.ts`、`src/gacha-*.ts` | 祈愿页操作、活动历史、计时和 UIGF 导入交互 |
| `src/*.css` | 按通用界面和功能页拆分的样式 |
| `src-tauri/src/commands.rs` | 账号与记录的 IPC 命令 |
| `src-tauri/src/gacha.rs`、`gacha_stats.rs`、`gacha_history.rs`、`gacha_events.rs` | 祈愿记录持久化与统计 |
| `src-tauri/src/uigf.rs`、`uigf_commands.rs` | UIGF 数据转换与文件对话框 |
| `src-tauri/src/http.rs` | 统一网络请求和安全日志 |

SQLite 数据位于应用数据目录。日志由 `tauri-plugin-log` 写入本地并供反馈中心采集；日志格式和敏感字段处理须遵守 [AGENTS.md](AGENTS.md)。

活动期和物品元数据由 `scripts/` 维护。更新说明只在 [CHANGELOG.md](CHANGELOG.md) 编写。发版、分发和日志约定以 [AGENTS.md](AGENTS.md) 为准；仅在明确要求发版时触发发布流程。
