//! UIGF 文件选择与后台导入导出命令。

use crate::response::{ApiError, ApiResult};
use crate::state::AppState;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// UIGF 祈愿记录导入/导出
// ---------------------------------------------------------------------------

/// 选择并导入 UIGF 文件（v4.0+）。返回导入摘要。
/// 对话框用回调式 API + oneshot 桥接：blocking_* 变体在 async command 中
/// 对话框关闭后仍不返回（实测死锁），回调式由主线程事件循环驱动无此问题。
#[tauri::command]
pub async fn uigf_import(handle: AppHandle) -> ApiResult<crate::uigf::UigfImportDto> {
    log::info!("[uigf] 打开导入文件选择器");
    let result = import_file(&handle).await;
    match &result {
        Ok(report) => log::info!("[uigf] 导入完成，账号数={}", report.accounts.len()),
        Err(error) if error.code == -100 => log::info!("[uigf] 用户取消导入"),
        Err(error) => log::warn!("[uigf] 导入失败: {error}"),
    }
    result
}

async fn import_file(handle: &AppHandle) -> ApiResult<crate::uigf::UigfImportDto> {
    let file_path = pick_file_await(handle, "UIGF 祈愿记录", &["json"]).await?;
    let Some(fp) = file_path else {
        return Err(ApiError::retcode(-100, "已取消选择文件"));
    };
    let Some(path) = fp.as_path().map(|p| p.to_path_buf()) else {
        return Err(ApiError::retcode(-101, "选择的路径无效"));
    };
    log::info!("[uigf] 开始导入文件");
    let worker_handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let content = std::fs::read_to_string(&path)
            .map_err(|e| ApiError::retcode(-102, format!("读取文件失败: {e}")))?;
        let state = worker_handle.state::<AppState>();
        crate::uigf::import_uigf_with_progress(&state, &content, |progress| {
            let _ = worker_handle.emit("uigf://progress", progress);
        })
    })
    .await
    .map_err(|e| ApiError::transport(format!("导入任务失败: {e}")))?
}

/// 导出指定 UID 为 UIGF v4.0 文件（弹出保存对话框）。
#[tauri::command]
pub async fn uigf_export(handle: AppHandle, uid: String) -> ApiResult<String> {
    log::info!("[uigf] 开始导出 uid={uid}");
    let result = export_file(&handle, &uid).await;
    match &result {
        Ok(_) => log::info!("[uigf] 导出完成 uid={uid}"),
        Err(error) if error.code == -100 => log::info!("[uigf] 用户取消导出 uid={uid}"),
        Err(error) => log::warn!("[uigf] 导出失败 uid={uid}: {error}"),
    }
    result
}

async fn export_file(handle: &AppHandle, uid: &str) -> ApiResult<String> {
    let version = handle.package_info().version.to_string();
    let worker_handle = handle.clone();
    let export_uid = uid.to_owned();
    let json = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        crate::uigf::export_uigf(&worker_handle.state::<AppState>(), &export_uid, &version)
    })
    .await
    .map_err(|e| ApiError::transport(format!("导出任务失败: {e}")))??;
    let file_path = save_file_await(
        handle,
        "UIGF 祈愿记录",
        &["json"],
        format!("OpenHoyo UIGF v4.0 ({uid}).json"),
    )
    .await?;
    let Some(fp) = file_path else {
        return Err(ApiError::retcode(-100, "已取消保存"));
    };
    let Some(path) = fp.as_path().map(|p| p.to_path_buf()) else {
        return Err(ApiError::retcode(-101, "保存路径无效"));
    };
    let saved_path = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, json))
        .await
        .map_err(|e| ApiError::transport(format!("写入任务失败: {e}")))?
        .map_err(|e| ApiError::retcode(-103, format!("写入文件失败: {e}")))?;
    Ok(saved_path)
}

/// 回调式文件选择：对话框在主线程弹出，关闭时回调经 oneshot 唤醒本协程。
/// 用户取消时回调收到 None，由调用方按 -100 静默处理。
async fn pick_file_await(
    handle: &AppHandle,
    name: &str,
    extensions: &[&str],
) -> ApiResult<Option<tauri_plugin_dialog::FilePath>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle
        .dialog()
        .file()
        .add_filter(name, extensions)
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    rx.await
        .map_err(|e| ApiError::transport(format!("对话框回调丢失: {e}")))
}

/// 回调式保存对话框，同 pick_file_await。
async fn save_file_await(
    handle: &AppHandle,
    name: &str,
    extensions: &[&str],
    default_name: String,
) -> ApiResult<Option<tauri_plugin_dialog::FilePath>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle
        .dialog()
        .file()
        .add_filter(name, extensions)
        .set_file_name(default_name)
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    rx.await
        .map_err(|e| ApiError::transport(format!("对话框回调丢失: {e}")))
}
