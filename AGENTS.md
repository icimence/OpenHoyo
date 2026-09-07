# AGENTS.md — 开发约定（人类与 AI 协作者都需遵守）

本文件记录本仓库的强制性开发约定。改动涉及以下任何一项时，必须保持约定不被破坏。

## 日志体系（反馈中心的诊断根基）

应用日志由 `tauri-plugin-log` 写入
`%LOCALAPPDATA%\com.learnrepo.hoyoauth\logs\hoyoauth.log`（2MB 轮转，保留一份旧档）。
设置页「反馈中心」会把**最近 10 分钟**的日志打包进 zip 并内联到 GitHub Issue 正文——
日志里没有诊断信息，反馈就没有价值。**这是新功能开发时必须维护的体系，不是可选装饰。**

### 行格式（不许改动）

```
[YYYY-MM-DD HH:MM:SS][LEVEL][target] message
```

该格式由 `lib.rs` 中插件的 `.format(...)` 产生，`feedback.rs::parse_log_timestamp`
按 `[YYYY-MM-DD HH:MM:SS]` 前缀解析做时间窗过滤。**两处必须同步改**，否则反馈采集退化为
"无时间戳取末尾 400 行"。

### 打日志的方式

- **Rust 后端**：`log::info!` / `log::warn!`，消息以方括号模块前缀开头：
  `[http] [gacha] [verify] [dailynote] [chronicle] [user] [startup] [feedback]`。
  新模块自建前缀，保持同风格。
- **前端**：直接 `console.info` / `console.warn` / `console.error`。
  `src/log.ts` 的 `initFrontendLog()`（main() 最早期调用）已把 console 挂接到日志文件，
  消息带 `[js]` 标记。**不要使用 `attachConsole`**——那是"后端→前端"方向的回显，
  与 console 桥叠加会形成回环。

### 必须打点的位置（新代码 Checklist）

1. **新的 tauri command**：入口一行 info（关键参数），成功/失败各一行结果
   （失败含 `retcode` 与 `message`，参照 `commands.rs` 现有写法）。
2. **网络请求**：一律走 `http::request`，那里已统一追踪（方法、URL 路径、retcode、耗时）。
   新请求不要绕过该函数自建 HTTP 调用。
3. **用户可感知的状态变化**：登录/登出、刷新、切档、版本更新等入口与结果。
4. **级别**：正常流程 `info`；API 返回非 0 或可恢复失败 `warn`；异常/panic 级 `error`。

### 隐私红线

URL query 里含 `authkey` / `stoken` 等凭证——**日志只允许记 URL 路径（`?` 之前）**，
`http.rs` 已按此实现。任何新打点不得输出：完整 query、Cookie、stoken/ltoken/cookie_token、
authkey、设备指纹原文。

## 其他强制约定

- **更新分发体系**（对齐 BetterGI 的多渠道模型）：
  - 版本检查主源 = 阿里云 OSS `openhoyo-updates/updates/notice.json`（version + gray 灰度），
    前端按 deviceId 哈希 %10 < gray 门控；OSS 不可达回退 GitHub（endpoints 第二顺位）
  - 安装包国内下载源 = CNB（`openhoyo/openhoyo-release` 仓库 release 资产，免费）；
    OSS 上的 `latest.json` 的 download.url 指向 CNB——**改 OSS 这个 json 即可切换下载源，无需发版**
  - CI 访问 OSS 用 GitHub OIDC → STS 临时凭证（`scripts/oss-sts-publish.py`），
    仓库不存任何阿里云长期密钥；发版后灰度恒为 0，由 `update-gray.yml`（workflow_dispatch）
    手动放量，出问题调回 0 熔断
  - 完整性由 minisign 签名保证（私钥仅在 GitHub Secrets），任一分发渠道被篡改均验签失败
  - **更新说明（首启弹窗）的唯一编写处是根目录 `CHANGELOG.md`**：发版前为本次版本
    编写 `## vX.Y.Z` 段落并推送；CI distribute 环节提取该段落上传 OSS 并同步
    GitHub Release 正文，段落缺失时用固定兜底文案（git log 是开发者视角，
    **不得**透出给用户）
- **serde 方向性 rename**：米哈游接口的错拼/大写字段（如 `fight_statisic`、`Day`）用
  `#[serde(rename(serialize = "规范名", deserialize = "错拼名"))]`——入库容忍错拼，
  出站给前端规范化。
- **弹性反序列化**：米哈游大量数字字段以字符串返回，用 `de_i32_flexible` 等助手。
- **防事件回环**：后端命令**不得**广播 `users://changed`（会触发前端整页重载→再请求→
  死循环，历史上造成过黑屏）。
- **发版规则**：只在用户明确说"发版"后才允许触发 `release.yml` / 打标签发布；
  平时的改动只 commit + push。
- **祈愿 UP 判定**：按名称匹配（国服接口不返回 item_id），数据源
  `gacha_events.json` 的当期窗口来自米哈游公告 API、历史窗口沿用现有文件；
  `scripts/gen-gacha-events.mjs` 内置"武器池必须双 UP"断言，CI 红了先查数据源。
