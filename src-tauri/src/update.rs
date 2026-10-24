//! 更新数据：CNB 主源、GitHub 备用，OSS 保留为迁移兼容源。
//! 发布工作流同步三边；客户端只读公开附件，不需要 CNB 令牌。

use crate::constants::Salts;
use crate::http::{self, Devices, RequestSpec, ResponseFormat};
use crate::response::{ApiError, ApiResult};
use crate::state::AppState;
use serde::Serialize;
use std::time::Duration;
use tauri::State;

const OSS_BASE: &str = "https://openhoyo-updates.oss-cn-hangzhou.aliyuncs.com/updates";
const CNB_BASE: &str = "https://cnb.cool/openhoyo/openhoyo-release/-/releases";
const GITHUB_BASE: &str = "https://github.com/icimence/OpenHoyo/releases";

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

fn valid_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.chars().all(|ch| ch.is_ascii_digit())
                && part.parse::<u32>().is_ok()
        })
}

fn validate_notice(raw: NoticeRaw) -> ApiResult<UpdateNotice> {
    if !valid_version(&raw.version) || raw.gray > 10 {
        return Err(ApiError::retcode(-30, "更新通告的版本或灰度比例无效"));
    }
    let android_url = raw.android.map(|a| a.url);
    if android_url
        .as_ref()
        .is_some_and(|url| !url.starts_with("https://"))
    {
        return Err(ApiError::retcode(-30, "安卓更新地址无效"));
    }
    Ok(UpdateNotice {
        version: raw.version,
        gray: raw.gray,
        android_url,
    })
}

async fn notice_from_sources(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    sources: &[(&str, String)],
) -> ApiResult<UpdateNotice> {
    for (source, url) in sources {
        let result = match http::request::<NoticeRaw>(
            client,
            salts,
            devices,
            RequestSpec::public_get(url, ResponseFormat::Json),
        )
        .await
        {
            Ok(response) => crate::response::unwrap_envelope(response.envelope, "notice.json")
                .and_then(validate_notice),
            Err(error) => Err(error),
        };
        match result {
            Ok(notice) => {
                log::info!(
                    "[updater] 更新通告成功 source={source} version={} gray={}",
                    notice.version,
                    notice.gray
                );
                return Ok(notice);
            }
            Err(error) => log::warn!(
                "[updater] 更新通告失败 source={source} retcode={} message={}",
                error.code,
                error.message
            ),
        }
    }
    Err(ApiError::retcode(-30, "所有更新通告源均不可用"))
}

/// CNB → GitHub → OSS（兼容迁移前的发布）；保留各源的灰度门控。
#[tauri::command]
pub async fn update_notice(state: State<'_, AppState>) -> ApiResult<UpdateNotice> {
    log::info!("[updater] 拉取更新通告");
    let salts = crate::state::salts(&state).await;
    let result = notice_from_sources(
        &state.http,
        &salts,
        &state.devices,
        &[
            ("CNB", format!("{CNB_BASE}/latest/download/notice.json")),
            (
                "GitHub",
                format!("{GITHUB_BASE}/latest/download/notice.json"),
            ),
            ("OSS", format!("{OSS_BASE}/notice.json")),
        ],
    )
    .await;
    if let Err(error) = &result {
        log::warn!(
            "[updater] 拉取更新通告失败 retcode={} message={}",
            error.code,
            error.message
        );
    }
    result
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
pub async fn android_update_download(
    app: tauri::AppHandle,
    url: String,
    version: String,
) -> ApiResult<String> {
    use tauri::{Emitter, Manager};
    use tokio::io::AsyncWriteExt;

    let path_only = url.split('?').next().unwrap_or(&url).to_string();
    log::info!("[updater] 开始下载安卓更新包 v{version}：{path_only}");
    if !url.starts_with("https://") {
        return Err(ApiError::retcode(-31, "下载地址无效"));
    }
    if version.is_empty()
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
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
            let _ = app.emit(
                "update://android-progress",
                AndroidProgress { received, total },
            );
        }
    }
    file.flush()
        .await
        .map_err(|e| ApiError::retcode(-32, format!("写入失败: {e}")))?;
    drop(file);
    if total > 0 && received != total {
        log::warn!("[updater] 安卓更新包不完整：{received}/{total} 字节");
        return Err(ApiError::transport("下载不完整，请重试"));
    }
    tokio::fs::rename(&partial, &target)
        .await
        .map_err(|e| ApiError::retcode(-32, format!("保存失败: {e}")))?;
    let _ = app.emit(
        "update://android-progress",
        AndroidProgress {
            received,
            total: received,
        },
    );
    log::info!(
        "[updater] 安卓更新包下载完成（{:.1} MB，耗时 {} 秒）",
        received as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs()
    );
    Ok(target.to_string_lossy().to_string())
}

fn readable_notes(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty()
        && !text.to_ascii_lowercase().starts_with("<!doctype html")
        && !text.to_ascii_lowercase().starts_with("<html")
}

/// 指定版本附件按 CNB → GitHub → OSS 读取，旧 GitHub Release 正文作为最后兜底。
#[tauri::command]
pub async fn update_notes(state: State<'_, AppState>, version: String) -> ApiResult<String> {
    log::info!("[updater] 拉取更新说明 version={version}");
    if !valid_version(&version) {
        log::warn!("[updater] 更新说明失败 retcode=-30 message=版本号无效");
        return Err(ApiError::retcode(-30, "版本号无效"));
    }
    let salts = crate::state::salts(&state).await;
    let sources = [
        (
            "CNB",
            format!("{CNB_BASE}/download/v{version}/notes.md"),
            ResponseFormat::Text,
        ),
        (
            "GitHub",
            format!("{GITHUB_BASE}/download/v{version}/notes.md"),
            ResponseFormat::Text,
        ),
        (
            "OSS",
            format!("{OSS_BASE}/releases/v{version}.md"),
            ResponseFormat::Text,
        ),
        (
            "GitHub Release",
            format!("https://api.github.com/repos/icimence/OpenHoyo/releases/tags/v{version}"),
            ResponseFormat::Json,
        ),
    ];
    for (source, url, format) in sources {
        let result = http::request::<serde_json::Value>(
            &state.http,
            &salts,
            &state.devices,
            RequestSpec::public_get(url, format),
        )
        .await;
        let result = result
            .and_then(|response| crate::response::unwrap_envelope(response.envelope, "更新说明"));
        match result {
            Ok(value) => {
                let text = value
                    .as_str()
                    .or_else(|| value.get("body").and_then(|body| body.as_str()))
                    .unwrap_or_default();
                if readable_notes(text) {
                    log::info!("[updater] 更新说明成功 version={version} source={source}");
                    return Ok(text.trim().to_string());
                }
                log::warn!("[updater] 更新说明无效 version={version} source={source} retcode=-30 message=说明为空或返回网页");
            }
            Err(error) => log::warn!(
                "[updater] 更新说明失败 version={version} source={source} retcode={} message={}",
                error.code,
                error.message
            ),
        }
    }
    log::warn!("[updater] 更新说明全部失败 version={version} retcode=-30 message=更新说明不存在");
    Err(ApiError::retcode(-30, "更新说明不存在"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn server(status: &str, body: &str) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/notice.json", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 8192];
            let count = stream.read(&mut bytes).unwrap();
            let headers = String::from_utf8_lossy(&bytes[..count]).to_lowercase();
            assert!(
                !headers.contains("x-rpc-")
                    && !headers.contains("cookie:")
                    && !headers.contains("\r\nds:")
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        (url, handle)
    }

    #[tokio::test]
    async fn missing_cnb_falls_back_to_github_without_losing_gray_or_android() {
        let (missing, first) = server("404 Not Found", "missing");
        let (backup, second) = server(
            "200 OK",
            r#"{"version":"0.1.15","gray":0,"android":{"url":"https://github.com/test.apk"}}"#,
        );
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = notice_from_sources(
            &client,
            &Salts::default(),
            &Devices::new(),
            &[("CNB", missing), ("GitHub", backup)],
        )
        .await
        .unwrap();
        assert_eq!(result.gray, 0);
        assert_eq!(
            result.android_url.as_deref(),
            Some("https://github.com/test.apk")
        );
        first.join().unwrap();
        second.join().unwrap();
    }

    #[tokio::test]
    async fn invalid_notice_falls_back_to_legacy_oss() {
        let (invalid, first) = server("200 OK", r#"{"version":"0.1.15","gray":100}"#);
        let (legacy, second) = server("200 OK", r#"{"version":"0.1.14","gray":10}"#);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = notice_from_sources(
            &client,
            &Salts::default(),
            &Devices::new(),
            &[("CNB", invalid), ("OSS", legacy)],
        )
        .await
        .unwrap();
        assert_eq!(result.version, "0.1.14");
        assert_eq!(result.gray, 10);
        assert!(result.android_url.is_none());
        first.join().unwrap();
        second.join().unwrap();
    }

    #[test]
    fn notes_reject_empty_and_login_html() {
        assert!(!readable_notes(" \n\t"));
        assert!(!readable_notes("<!DOCTYPE html><title>login</title>"));
        assert!(readable_notes("- 同步斯柯克卡池"));
        assert!(!valid_version("../latest"));
    }
}
