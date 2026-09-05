//! HoyoAuth —— 米哈游账号登录示例（Tauri 重制版）
//!
//! 模块划分与原 Snap.Hutao 对应关系：
//! - constants  ← HoyolabOptions / ApiEndpoints / SaltConstants
//! - cookie     ← Web/Hoyolab/Cookie(.Constant/.Extension)
//! - ds         ← DataSigning/*
//! - http       ← HttpClientConfiguration + HoyolabHttpRequestMessageBuilderExtension
//! - passport   ← PassportClient / HoyoPlayPassportClient
//! - user_api   ← UserClient / BindingClient / AuthClient
//! - device_fp  ← UserFingerprintService / DeviceFpClient
//! - store      ← Model.Entity.User + IUserRepository
//! - service    ← UserService / UserInitializationService / UserCollectionService

// 设备指纹的 json! 宏字段较多，需要提高宏展开递归上限
#![recursion_limit = "256"]

mod commands;
mod constants;
mod cookie;
mod device_fp;
mod ds;
mod gacha;
mod gacha_events;
mod gacha_stats;
mod http;
mod models;
mod passport;
mod random;
mod response;
mod service;
mod state;
mod store;
mod user_api;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("无法获取应用数据目录");
            std::fs::create_dir_all(&dir).expect("无法创建应用数据目录");

            let conn = rusqlite::Connection::open(dir.join("users.db"))
                .expect("无法打开数据库");
            store::init(&conn).expect("无法初始化数据库");
            gacha::init_tables(&conn).expect("无法初始化祈愿记录表");

            app.manage(state::AppState::new(conn));

            // 启动任务：刷新 salt + 恢复所有用户（懒刷新过期凭证）
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<state::AppState>();
                service::startup_resume(&state, &handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_users,
            commands::qr_login_create,
            commands::qr_login_poll,
            commands::mobile_captcha_send,
            commands::mobile_captcha_login,
            commands::cookie_login,
            commands::remove_user,
            commands::refresh_cookie_token,
            commands::export_user_cookies,
            commands::gacha_archives,
            commands::gacha_statistics,
            commands::gacha_remove_archive,
            commands::gacha_refresh_by_stoken,
            commands::gacha_refresh_by_web_cache,
            commands::gacha_refresh_by_manual,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
