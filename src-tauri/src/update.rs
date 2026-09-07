//! 更新体系支撑：OSS 版本通告（灰度门控）与新版本更新说明。
//!
//! 对应 BetterGI UpdateService 的 UpdateFromOss 思路：
//! - notice.json（OSS）是版本检查的国内主源，含灰度比例；
//!   应用侧按 deviceId 哈希决定是否提示更新（前端实现）。
//! - 更新说明 md 优先取 OSS，失败回退 GitHub Release API（海外用户路径）。
//! OSS 元数据由 CI 用 OIDC→STS 临时凭证写入，无长期密钥（见 AGENTS.md）。

use crate::response::{ApiError, ApiResult};
use serde::Serialize;
use std::time::Duration;

const OSS_BASE: &str = "https://openhoyo-updates.oss-cn-hangzhou.aliyuncs.com/updates";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotice {
    pub version: String,
    pub gray: u8,
}

#[derive(serde::Deserialize)]
struct NoticeRaw {
    version: String,
    #[serde(default)]
    gray: u8,
}

/// 拉取版本通告（国内主源）。失败由前端回退 tauri updater 的 GitHub 直查。
#[tauri::command]
pub async fn update_notice() -> ApiResult<UpdateNotice> {
    let resp = reqwest::get(format!("{OSS_BASE}/notice.json"))
        .await
        .map_err(|e| ApiError::transport(format!("notice.json 请求失败: {e}")))?
        .error_for_status()
        .map_err(|e| ApiError::transport(format!("notice.json 响应异常: {e}")))?;
    let raw: NoticeRaw = resp
        .json()
        .await
        .map_err(|e| ApiError::transport(format!("notice.json 解析失败: {e}")))?;
    Ok(UpdateNotice {
        version: raw.version,
        gray: raw.gray,
    })
}

/// 拉取指定版本的更新说明（OSS 主源 → GitHub Release API 兜底）
#[tauri::command]
pub async fn update_notes(version: String) -> ApiResult<String> {
    // OSS：CI 发版时写入
    if let Ok(resp) = reqwest::get(format!("{OSS_BASE}/releases/v{version}.md")).await {
        if resp.status().is_success() {
            if let Ok(text) = resp.text().await {
                if !text.trim().is_empty() {
                    return Ok(text);
                }
            }
        }
    }

    // GitHub 兜底（海外用户 / OSS 异常）
    let url = format!("https://api.github.com/repos/icimence/OpenHoyo/releases/tags/v{version}");
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| ApiError::transport(e.to_string()))?
        .get(url)
        .header("User-Agent", "OpenHoyo-Updater")
        .send()
        .await
        .map_err(|e| ApiError::transport(format!("GitHub Release 请求失败: {e}")))?;
    let body: serde_json::Value = resp
        .error_for_status()
        .map_err(|e| ApiError::transport(format!("GitHub Release 响应异常: {e}")))?
        .json()
        .await
        .map_err(|e| ApiError::transport(e.to_string()))?;
    body.get("body")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| ApiError::retcode(-30, "更新说明不存在"))
}
