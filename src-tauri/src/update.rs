//! 更新体系支撑：OSS 版本通告（灰度门控）与新版本更新说明。
//!
//! 对应 BetterGI UpdateService 的 UpdateFromOss 思路：
//! - notice.json（OSS）是版本检查的国内主源，含灰度比例；
//!   应用侧按 deviceId 哈希决定是否提示更新（前端实现）。
//! - 更新说明 md 优先取 OSS，失败回退 GitHub Release API（海外用户路径）。
//!
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
    /// 安卓 APK 下载地址（CNB 国内源）。旧版 notice.json 没有该字段时为 None
    pub android_url: Option<String>,
}

#[derive(serde::Deserialize)]
struct NoticeRaw {
    version: String,
    #[serde(default)]
    gray: u8,
    #[serde(default)]
    android: Option<AndroidNotice>,
}

/// notice.json 中的安卓条目：CI 发版时与桌面安装包一起写入
#[derive(serde::Deserialize)]
struct AndroidNotice {
    url: String,
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
        android_url: raw.android.map(|a| a.url).filter(|u| u.starts_with("https://")),
    })
}

/// 安卓更新包下载进度（事件 update://android-progress）
#[derive(Clone, Serialize)]
struct AndroidProgress {
    received: u64,
    total: u64,
}

/// 安卓：应用内下载 APK 到缓存目录 updates/，返回本地路径（由原生桥拉起系统安装器）。
/// 只接受 https；完整性由安卓的签名一致性校验保证（被篡改的包无法覆盖安装）。
#[tauri::command]
pub async fn android_update_download(app: tauri::AppHandle, url: String, version: String) -> ApiResult<String> {
    use tauri::{Emitter, Manager};
    use tokio::io::AsyncWriteExt;

    let path_only = url.split('?').next().unwrap_or(&url).to_string();
    log::info!("[updater] 开始下载安卓更新包 v{version}：{path_only}");
    if !url.starts_with("https://") {
        return Err(ApiError::retcode(-31, "下载地址无效"));
    }
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err(ApiError::retcode(-31, "版本号无效"));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| ApiError::retcode(-32, format!("无法定位缓存目录: {e}")))?
        .join("updates");
    // 只保留本次的包：旧版本残留的 APK 一并清掉
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::retcode(-32, format!("创建下载目录失败: {e}")))?;
    let target = dir.join(format!("OpenHoyo-{version}.apk"));
    let partial = dir.join(format!("OpenHoyo-{version}.apk.part"));

    let started = std::time::Instant::now();
    let mut resp = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| ApiError::transport(e.to_string()))?
        .get(&url)
        .header("User-Agent", "OpenHoyo-Updater")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| {
            log::warn!("[updater] 安卓更新包请求失败: {e}");
            ApiError::transport(format!("下载失败: {e}"))
        })?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| ApiError::retcode(-32, format!("写入失败: {e}")))?;
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    loop {
        let chunk = match tokio::time::timeout(Duration::from_secs(30), resp.chunk()).await {
            Ok(Ok(Some(c))) => c,
            Ok(Ok(None)) => break,
            Ok(Err(e)) => {
                log::warn!("[updater] 安卓更新包下载中断: {e}");
                return Err(ApiError::transport(format!("下载中断: {e}")));
            }
            Err(_) => {
                log::warn!("[updater] 安卓更新包下载超时（30 秒无数据）");
                return Err(ApiError::transport("下载超时，请检查网络后重试"));
            }
        };
        file.write_all(&chunk)
            .await
            .map_err(|e| ApiError::retcode(-32, format!("写入失败: {e}")))?;
        received += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = std::time::Instant::now();
            let _ = app.emit("update://android-progress", AndroidProgress { received, total });
        }
    }
    file.flush().await.map_err(|e| ApiError::retcode(-32, format!("写入失败: {e}")))?;
    drop(file);
    if total > 0 && received != total {
        log::warn!("[updater] 安卓更新包不完整：{received}/{total} 字节");
        return Err(ApiError::transport("下载不完整，请重试"));
    }
    tokio::fs::rename(&partial, &target)
        .await
        .map_err(|e| ApiError::retcode(-32, format!("保存失败: {e}")))?;
    let _ = app.emit("update://android-progress", AndroidProgress { received, total: received });
    log::info!(
        "[updater] 安卓更新包下载完成（{:.1} MB，耗时 {} 秒）",
        received as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs()
    );
    Ok(target.to_string_lossy().to_string())
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
