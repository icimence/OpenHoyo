//! 反馈中心（设置页内嵌，对应需求：完整传递背景信息到 GitHub Issue）。
//!
//! 提交时：
//! 1. 采集诊断信息 —— 应用元数据（版本/系统/区域设置）、最近 N 分钟运行日志、
//!    崩溃转储（WebView2 Crashpad / WER LocalDumps，如有）、用户选择的图片；
//! 2. 打包为 zip（app_data/feedback/）；
//! 3. 用系统浏览器打开预填标题与正文的 GitHub 新建 Issue 页面，
//!    并在资源管理器中定位 zip，供用户拖入上传（浏览器上传需要用户登录态，
//!    应用内不做任何 GitHub 凭据存储）。

use crate::response::{ApiError, ApiResult};
use chrono::{Local, NaiveDateTime};
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

const ISSUE_URL_BASE: &str = "https://github.com/icimence/OpenHoyo/issues/new";
/// 日志采集窗口（分钟）
const LOG_WINDOW_MINUTES: i64 = 10;
/// Issue 正文中内联日志的字符上限（完整日志在 zip 中）
const INLINE_LOG_MAX_CHARS: usize = 24_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackResult {
    pub zip_path: String,
    pub issue_url: String,
    pub dump_count: usize,
    pub image_count: usize,
    /// 正文是否已成功复制到剪贴板（失败时用户需从 zip 内 issue-body.md 手动复制）
    pub clipboard_ok: bool,
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

fn windows_display_version() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    (|| {
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
            .ok()?;
        let name: String = key.get_value("ProductName").unwrap_or_else(|_| "Windows".into());
        let ver: String = key.get_value("DisplayVersion").ok()?;
        let build: String = key.get_value("CurrentBuildNumber").ok()?;
        Some(format!("{name} {ver} (build {build})"))
    })()
    .unwrap_or_else(|| format!("{} {}", std::env::consts::OS, std::env::consts::ARCH))
}

fn build_meta_json(app: &tauri::AppHandle, user_text: &str) -> String {
    let pkg = app.package_info();
    let meta = serde_json::json!({
        "app_name": pkg.name,
        "app_version": pkg.version.to_string(),
        "tauri_version": tauri::VERSION,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "os_version": windows_display_version(),
        "locale": std::env::var("LANG").unwrap_or_else(|_| "zh-CN".into()),
        "submitted_at": Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
        "log_window_minutes": LOG_WINDOW_MINUTES,
        "user_text": user_text,
    });
    serde_json::to_string_pretty(&meta).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 日志采集
// ---------------------------------------------------------------------------

/// 解析日志行前缀 `[YYYY-MM-DD HH:MM:SS]`（与 lib.rs 中配置的格式一致）
fn parse_log_timestamp(line: &str) -> Option<NaiveDateTime> {
    let inner = line.strip_prefix('[')?;
    let end = inner.find(']')?;
    NaiveDateTime::parse_from_str(&inner[..end], "%Y-%m-%d %H:%M:%S").ok()
}

/// 保留最近 `minutes` 分钟内的行；无法解析时间戳的行跟随前一行的去留
/// （多行日志消息的续行），全部行都无时间戳时退化为保留末尾。
fn keep_recent_lines(content: &str, now: NaiveDateTime, minutes: i64) -> String {
    let cutoff = now - chrono::Duration::minutes(minutes);
    let mut keep = false;
    let mut any_ts = false;
    let mut kept: Vec<&str> = Vec::new();
    for line in content.lines() {
        if let Some(ts) = parse_log_timestamp(line) {
            any_ts = true;
            keep = ts >= cutoff;
        }
        if keep {
            kept.push(line);
        }
    }
    let joined = if any_ts { kept.join("\n") } else { content.lines().rev().take(400).collect::<Vec<_>>().join("\n") };
    if joined.chars().count() > INLINE_LOG_MAX_CHARS {
        joined.chars().skip(joined.chars().count() - INLINE_LOG_MAX_CHARS).collect()
    } else {
        joined
    }
}

fn collect_log_text(app: &tauri::AppHandle) -> String {
    let Ok(log_dir) = app.path().app_log_dir() else {
        return "(无法定位日志目录)".into();
    };
    let mut files: Vec<PathBuf> = std::fs::read_dir(&log_dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    name.starts_with("hoyoauth.log") && name.ends_with(".log") || name.ends_with(".old")
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort(); // xxx.log < xxx.log.old，按序拼接

    let mut content = String::new();
    for f in &files {
        if let Ok(text) = std::fs::read_to_string(f) {
            content.push_str(&text);
            content.push('\n');
        }
    }
    if content.is_empty() {
        return "(日志文件为空或不存在——应用可能刚启用日志)".into();
    }
    content
}

// ---------------------------------------------------------------------------
// 崩溃转储扫描
// ---------------------------------------------------------------------------

/// 收集最近 7 天的 .dmp：WebView2 Crashpad 报告 + WER LocalDumps（如有配置）
fn scan_dumps(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(&local);
        dirs.push(base.join(&app.config().identifier).join("WebView2").join("Crashpad").join("reports"));
        dirs.push(base.join("CrashDumps"));
    }
    let week_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 3600);
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("dmp") {
                continue;
            }
            let fresh = e
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t >= week_ago)
                .unwrap_or(false);
            if fresh {
                out.push(p);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Issue 正文
// ---------------------------------------------------------------------------

fn build_issue_title(user_text: &str, app_version: &str) -> String {
    let head: String = user_text.trim().chars().take(30).collect();
    format!("[反馈] {head} - v{app_version}")
}

/// URL 预填正文的用户描述截断（中文百分号编码后每字符膨胀约 9 倍，
/// 400 字符 + 元数据表编码后约 5KB，留足 GitHub ~8KB 上限的余量）
const URL_TEXT_MAX_CHARS: usize = 400;

/// URL 预填正文：只有元数据与用户描述（无日志），打开即可见、无需用户粘贴
fn build_issue_body_compact(user_text: &str, app: &tauri::AppHandle, zip_name: &str, image_names: &[String]) -> String {
    build_issue_body_compact_inner(
        user_text,
        &app.package_info().version.to_string(),
        tauri::VERSION,
        &windows_display_version(),
        &std::env::var("LANG").unwrap_or_else(|_| "zh-CN".into()),
        &Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        zip_name,
        image_names,
    )
}

fn build_issue_body_compact_inner(
    user_text: &str,
    app_version: &str,
    tauri_version: &str,
    os_version: &str,
    locale: &str,
    submitted_at: &str,
    zip_name: &str,
    image_names: &[String],
) -> String {
    let trimmed = user_text.trim();
    let text: String = trimmed.chars().take(URL_TEXT_MAX_CHARS).collect();
    let truncated = trimmed.chars().count() > URL_TEXT_MAX_CHARS;

    let mut md = String::new();
    md.push_str("### 问题描述\n\n");
    md.push_str(&text);
    if truncated {
        md.push_str("\n\n> 描述过长已截断，全文见附件 zip 内 issue-body.md。\n");
    }
    md.push_str("\n\n### 环境信息\n\n");
    md.push_str(&format!(
        "| 项 | 值 |\n| --- | --- |\n| 应用版本 | v{app_version} |\n| Tauri | {tauri_version} |\n| 系统 | {os_version} |\n| 区域设置 | {locale} |\n| 提交时间 | {submitted_at} |\n"
    ));
    md.push_str(&format!(
        "\n### 附件\n\n完整诊断包 **`{zip_name}`**（含最近 10 分钟运行日志、崩溃转储与图片）\
         已在本机生成，反馈向导已打开所在文件夹，请拖入本 Issue 上传。\n"
    ));
    if !image_names.is_empty() {
        md.push_str(&format!("\n所选图片 {} 张：{}\n", image_names.len(), image_names.join("、")));
    }
    md
}

/// 完整正文（URL 版 + 内联日志段）：进剪贴板与 zip 的 issue-body.md
fn build_issue_body_full(compact: &str, log_excerpt: &str) -> String {
    format!("{compact}\n\n### 最近运行日志\n\n<details>\n\n```\n{log_excerpt}\n```\n\n</details>\n")
}

fn percent_encode(s: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

// ---------------------------------------------------------------------------
// 打包与提交
// ---------------------------------------------------------------------------

fn unique_entry_name(prefix: &str, name: &str, used: &mut std::collections::HashSet<String>) -> String {
    let safe: String = name.chars().filter(|c| !c.is_control() && *c != '/' && *c != '\\').collect();
    let mut candidate = safe.clone();
    let mut i = 1;
    while used.contains(&candidate) {
        candidate = format!("{i}-{safe}");
        i += 1;
    }
    used.insert(candidate.clone());
    format!("{prefix}/{candidate}")
}

pub fn build_feedback_zip(
    app: &tauri::AppHandle,
    user_text: &str,
    image_paths: &[String],
    include_logs: bool,
    include_dumps: bool,
) -> ApiResult<(PathBuf, String, String, String)> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ApiError::retcode(-20, format!("无法获取数据目录: {e}")))?;
    let fb_dir = data_dir.join("feedback");
    std::fs::create_dir_all(&fb_dir)
        .map_err(|e| ApiError::retcode(-21, format!("创建反馈目录失败: {e}")))?;
    let zip_path = fb_dir.join(format!("feedback-{}.zip", Local::now().format("%Y%m%d-%H%M%S")));

    let log_text = collect_log_text(app);
    let log_excerpt = keep_recent_lines(&log_text, Local::now().naive_local(), LOG_WINDOW_MINUTES);
    let dumps = if include_dumps { scan_dumps(app) } else { Vec::new() };

    let meta = build_meta_json(app, user_text);
    let title = build_issue_title(user_text, &app.package_info().version.to_string());
    let image_names: Vec<String> = image_paths
        .iter()
        .map(|p| PathBuf::from(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "image".into()))
        .collect();
    let compact = build_issue_body_compact(user_text, app, &zip_path.file_name().unwrap().to_string_lossy(), &image_names);
    let body = build_issue_body_full(&compact, &log_excerpt);

    let file = std::fs::File::create(&zip_path)
        .map_err(|e| ApiError::retcode(-22, format!("创建 zip 失败: {e}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("meta.json", opts)
        .map_err(|e| ApiError::retcode(-23, format!("写入 meta 失败: {e}")))?;
    zip.write_all(meta.as_bytes()).map_err(|e| ApiError::retcode(-23, format!("写入 meta 失败: {e}")))?;

    // Issue 正文快照（剪贴板被占用时的兜底）
    zip.start_file("issue-body.md", opts)
        .map_err(|e| ApiError::retcode(-23, format!("写入正文失败: {e}")))?;
    zip.write_all(body.as_bytes())
        .map_err(|e| ApiError::retcode(-23, format!("写入正文失败: {e}")))?;

    if include_logs {
        zip.start_file("logs/recent.log", opts)
            .map_err(|e| ApiError::retcode(-23, format!("写入日志失败: {e}")))?;
        zip.write_all(log_excerpt.as_bytes())
            .map_err(|e| ApiError::retcode(-23, format!("写入日志失败: {e}")))?;
        zip.start_file("logs/full.log", opts)
            .map_err(|e| ApiError::retcode(-23, format!("写入日志失败: {e}")))?;
        zip.write_all(log_text.as_bytes())
            .map_err(|e| ApiError::retcode(-23, format!("写入日志失败: {e}")))?;
    }

    let mut used = std::collections::HashSet::new();
    for dump in &dumps {
        if let Ok(bytes) = std::fs::read(dump) {
            let name = dump.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let entry = unique_entry_name("dumps", &name, &mut used);
            zip.start_file(entry, opts)
                .map_err(|e| ApiError::retcode(-23, format!("写入转储失败: {e}")))?;
            zip.write_all(&bytes).map_err(|e| ApiError::retcode(-23, format!("写入转储失败: {e}")))?;
        }
    }
    for (i, img) in image_paths.iter().enumerate() {
        if let Ok(bytes) = std::fs::read(img) {
            let base = PathBuf::from(img).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| format!("image-{i}"));
            let entry = unique_entry_name("images", &base, &mut used);
            zip.start_file(entry, opts)
                .map_err(|e| ApiError::retcode(-23, format!("写入图片失败: {e}")))?;
            zip.write_all(&bytes).map_err(|e| ApiError::retcode(-23, format!("写入图片失败: {e}")))?;
        }
    }
    zip.finish()
        .map_err(|e| ApiError::retcode(-24, format!("完成 zip 失败: {e}")))?;

    Ok((zip_path, title, compact, body))
}

/// 提交反馈：打包 → 弹指引（前端已弹，此处直接执行）→ URL 预填瘦身正文 →
/// 剪贴板写含日志全文 → 打开 Issue 页 → 资源管理器定位 zip。
/// URL 只带紧凑正文（元数据+描述，无日志），完整正文走剪贴板与 zip。
#[tauri::command]
pub async fn feedback_submit(
    app: tauri::AppHandle,
    text: String,
    image_paths: Vec<String>,
    include_logs: bool,
    include_dumps: bool,
) -> ApiResult<FeedbackResult> {
    let text = text.trim().to_string();
    if text.chars().count() < 5 {
        return Err(ApiError::retcode(-25, "请先描述问题（至少 5 个字）"));
    }
    for p in &image_paths {
        if !std::path::Path::new(p).is_file() {
            return Err(ApiError::retcode(-26, format!("图片不存在: {p}")));
        }
    }

    let (zip_path, title, compact, body) =
        build_feedback_zip(&app, &text, &image_paths, include_logs, include_dumps)?;
    let dump_count = scan_dumps(&app).len();

    // URL 预填紧凑正文（无日志），含日志全文进剪贴板作为可选增强
    let clipboard_ok = app.clipboard().write_text(&body).is_ok();
    let issue_url = format!(
        "{ISSUE_URL_BASE}?title={}&body={}",
        percent_encode(&title),
        percent_encode(&compact)
    );

    app.opener()
        .open_url(&issue_url, None::<&str>)
        .map_err(|e| ApiError::retcode(-27, format!("打开浏览器失败: {e}")))?;
    let _ = app.opener().reveal_item_in_dir(&zip_path);

    log::info!(
        "[feedback] 反馈包已生成: {}（转储 {dump_count}，图片 {}，剪贴板 {}）",
        zip_path.display(),
        image_paths.len(),
        if clipboard_ok { "已写入" } else { "写入失败" }
    );

    Ok(FeedbackResult {
        zip_path: zip_path.to_string_lossy().to_string(),
        issue_url,
        dump_count,
        image_count: image_paths.len(),
        clipboard_ok,
    })
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_line_time_filter() {
        let content = "[2026-09-06 10:00:00][INFO][app] 旧事件\n\
                       续行跟随旧行\n\
                       [2026-09-06 10:55:00][INFO][app] 新事件\n\
                       续行跟随新行\n";
        let now = NaiveDateTime::parse_from_str("2026-09-06 11:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let kept = keep_recent_lines(content, now, 10);
        assert!(!kept.contains("旧事件"), "窗口外的事件应被过滤: {kept}");
        assert!(!kept.contains("续行跟随旧行"), "无时间戳续行应跟随前一行被过滤");
        assert!(kept.contains("新事件") && kept.contains("续行跟随新行"));
    }

    #[test]
    fn log_fallback_without_timestamps() {
        let content = (0..1000).map(|i| format!("line-{i}")).collect::<Vec<_>>().join("\n");
        let now = NaiveDateTime::parse_from_str("2026-09-06 11:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let kept = keep_recent_lines(&content, now, 10);
        assert!(kept.contains("line-999") && !kept.contains("line-0"), "无时间戳时退化为保留末尾 400 行");
    }

    #[test]
    fn parse_timestamp_format() {
        assert!(parse_log_timestamp("[2026-09-06 10:55:03][WARN][t] x").is_some());
        assert!(parse_log_timestamp("普通文本").is_none());
    }

    #[test]
    fn issue_title_truncates() {
        let long = "这是一个非常长的反馈标题要被截断到三十个字符以内才行".repeat(3);
        let t = build_issue_title(&long, "0.1.5");
        assert!(t.chars().count() < 60 && t.starts_with("[反馈]"));
    }

    #[test]
    fn unique_entry_name_dedup() {
        let mut used = std::collections::HashSet::new();
        let a = unique_entry_name("images", "a.png", &mut used);
        let b = unique_entry_name("images", "a.png", &mut used);
        assert_eq!(a, "images/a.png");
        assert_ne!(a, b);
    }

    /// URL 预填正文在最坏情况下（描述打满 400 个中文字符 + 多张图片）
    /// 编码后也必须显著低于 GitHub ~8KB 的 URL 上限
    #[test]
    fn compact_issue_body_fits_url_limit() {
        let text = "问题".repeat(300); // 600 个中文字符 → 触发 400 截断
        let images: Vec<String> = (1..=6).map(|i| format!("截图第{i}张.png")).collect();
        let body = build_issue_body_compact_inner(
            &text,
            "0.1.5",
            "2.11.5",
            "Windows 10 Pro 25H2 (build 26200)",
            "zh-CN",
            "2026-09-07 00:30:00",
            "feedback-20260907-003000.zip",
            &images,
        );
        assert!(body.contains("已截断"), "超长描述应被截断: {}", &body[..80]);
        let encoded = format!(
            "{ISSUE_URL_BASE}?title={}&body={}",
            percent_encode("[反馈] 测试标题测试标题测试标题测试标题测试标题 - v0.1.5"),
            percent_encode(&body)
        );
        assert!(encoded.len() < 7000, "URL 编码后 {} 字符，超出安全范围", encoded.len());
    }

    #[test]
    fn full_body_contains_log_section() {
        let compact = build_issue_body_compact_inner(
            "测试", "0.1.5", "2.11.5", "Windows", "zh-CN", "t", "z.zip", &[]
        );
        let full = build_issue_body_full(&compact, "[2026-09-07 00:00:00][INFO][app] 日志行");
        assert!(full.contains("### 最近运行日志"));
        assert!(full.contains("日志行"));
        assert!(!compact.contains("最近运行日志"), "紧凑版不应包含日志段");
    }
}
