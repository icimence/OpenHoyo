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
mod daily_note;
mod device_fp;
mod ds;
mod feedback;
mod gacha;
mod gacha_events;
mod gacha_history;
mod gacha_item;
mod gacha_stats;
mod game_record;
mod http;
mod models;
mod passport;
mod random;
mod response;
mod service;
mod state;
mod static_res;
mod store;
mod uigf;
mod uigf_commands;
mod update;
mod user_api;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 自动更新与进程重启插件只有桌面端实现
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        // 官方图片本地缓存协议（见 static_res.rs）
        .register_asynchronous_uri_scheme_protocol("hoyoimg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(static_res::handle_protocol(app, request).await);
            });
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("hoyoauth.log".into()),
                    }),
                ])
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .level(log::LevelFilter::Info)
                // 行格式与 feedback::parse_log_timestamp 约定一致
                .format(|out, message, record| {
                    out.finish(format_args!(
                        "[{}][{}][{}] {}",
                        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                        record.level(),
                        record.target(),
                        message
                    ))
                })
                .build(),
        )
        .setup(|app| {
            let default_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            std::fs::create_dir_all(&default_dir).expect("无法创建应用数据目录");
            // 用户可在首启引导/设置中改数据目录（指针文件固定放在默认目录）
            let dir = static_res::resolve_data_dir(&default_dir);

            let conn = rusqlite::Connection::open(dir.join("users.db")).expect("无法打开数据库");
            store::init(&conn).expect("无法初始化数据库");
            gacha::init_tables(&conn).expect("无法初始化祈愿记录表");
            game_record::init_tables(&conn).expect("无法初始化周期记录表");
            static_res::cleanup_after_move(&conn, &dir);

            app.manage(static_res::StaticRes::new(dir.clone(), default_dir.clone(), &conn));
            app.manage(state::AppState::new(conn));

            log::info!(
                "应用启动 v{}（tauri {}，{} {}）",
                app.package_info().version,
                tauri::VERSION,
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            log::info!(
                "[startup] 数据目录：{}",
                if dir == default_dir { "默认位置" } else { "用户自定义位置" }
            );

            // 启动任务：刷新 salt + 恢复所有用户（懒刷新过期凭证）
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<state::AppState>();
                service::startup_resume(&state, &handle).await;
            });
            // 新版本可能新增角色/武器：用户同意本地保存时，后台补全缺失的官方图片
            tauri::async_runtime::spawn(static_res::auto_sync(app.handle().clone()));
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
            commands::refresh_role_avatar,
            commands::export_user_cookies,
            commands::gacha_archives,
            commands::gacha_statistics,
            gacha_events::gacha_countdown,
            commands::gacha_remove_archive,
            uigf_commands::uigf_import,
            uigf_commands::uigf_export,
            commands::gacha_refresh_by_stoken,
            commands::gacha_refresh_by_web_cache,
            commands::gacha_refresh_by_manual,
            commands::daily_note,
            commands::card_create_verification,
            commands::card_verify_verification,
            commands::chronicle_list,
            commands::chronicle_refresh,
            commands::avatar_property_refresh,
            commands::avatar_property_cache,
            feedback::feedback_submit,
            update::update_notice,
            update::update_notes,
            update::android_update_download,
            static_res::static_res_status,
            static_res::static_res_activity,
            static_res::static_res_set_enabled,
            static_res::static_res_download,
            static_res::static_res_cancel,
            static_res::static_res_clear,
            static_res::guide_set_step,
            static_res::data_folder_check,
            static_res::data_folder_set,
            static_res::data_folder_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
