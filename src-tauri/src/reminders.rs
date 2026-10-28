//! 分档恢复提醒：配置、快照、去重状态入库；Windows 仅在进程内走针，安卓交给系统。
mod engine;
use crate::{
    daily_note::DailyNoteData,
    response::{ApiError, ApiResult},
    state::AppState,
    store,
};
use engine::{Job, Settings};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

#[derive(Default)]
pub struct ReminderGate(tokio::sync::Mutex<()>);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Profile {
    settings: Settings,
    #[serde(default, deserialize_with = "deserialize_snapshot")]
    snapshot: Option<DailyNoteData>,
    error: Option<String>,
}

/// API 模型故意忽略服务端的 fetched_at_ms；读取本地快照时须单独恢复可信的采集时间。
fn deserialize_snapshot<'de, D>(deserializer: D) -> Result<Option<DailyNoteData>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    value
        .map(|raw| {
            let fetched_at_ms = raw
                .get("fetched_at_ms")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let mut note: DailyNoteData =
                serde_json::from_value(raw).map_err(serde::de::Error::custom)?;
            note.fetched_at_ms = fetched_at_ms;
            Ok(note)
        })
        .transpose()
}
#[derive(Serialize)]
pub struct Status {
    settings: Settings,
    snapshot: Option<DailyNoteData>,
    jobs: Vec<Job>,
    error: Option<String>,
}
fn db_error(e: impl std::fmt::Display) -> ApiError {
    ApiError::retcode(-4, format!("提醒数据保存失败：{e}"))
}
fn notify_error(e: impl std::fmt::Display) -> ApiError {
    ApiError::retcode(-7, format!("系统通知操作失败：{e}"))
}
fn report<T>(operation: &str, result: &ApiResult<T>) {
    match result {
        Ok(_) => log::info!("[reminder] {operation}成功"),
        Err(e) => log::warn!(
            "[reminder] {operation}失败 retcode={} message={}",
            e.code,
            e.message
        ),
    }
}
pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS reminder_profiles (
        user_id INTEGER NOT NULL, game_uid TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (user_id, game_uid));
        CREATE TABLE IF NOT EXISTS reminder_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        game_uid TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS reminder_jobs_role ON reminder_jobs(user_id, game_uid);",
    )
}
fn read(conn: &Connection, user: i64, uid: &str) -> ApiResult<(Profile, Vec<Job>)> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM reminder_profiles WHERE user_id=?1 AND game_uid=?2",
            params![user, uid],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let profile = raw
        .map(|s| serde_json::from_str(&s).map_err(db_error))
        .transpose()?
        .unwrap_or_default();
    let mut stmt = conn
        .prepare("SELECT payload FROM reminder_jobs WHERE user_id=?1 AND game_uid=?2 ORDER BY id")
        .map_err(db_error)?;
    let raw = stmt
        .query_map(params![user, uid], |r| r.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    let jobs = raw
        .iter()
        .map(|s| serde_json::from_str(s).map_err(db_error))
        .collect::<ApiResult<Vec<Job>>>()?;
    Ok((profile, jobs))
}
fn write(
    conn: &mut Connection,
    user: i64,
    uid: &str,
    profile: &Profile,
    jobs: &mut [Job],
) -> ApiResult<()> {
    let tx = conn.transaction().map_err(db_error)?;
    tx.execute(
        "INSERT INTO reminder_profiles (user_id,game_uid,payload) VALUES (?1,?2,?3)
        ON CONFLICT(user_id,game_uid) DO UPDATE SET payload=excluded.payload",
        params![user, uid, serde_json::to_string(profile).map_err(db_error)?],
    )
    .map_err(db_error)?;
    tx.execute(
        "DELETE FROM reminder_jobs WHERE user_id=?1 AND game_uid=?2",
        params![user, uid],
    )
    .map_err(db_error)?;
    for job in jobs {
        if job.id == 0 {
            tx.execute(
                "INSERT INTO reminder_jobs (user_id,game_uid,payload) VALUES (?1,?2,'')",
                params![user, uid],
            )
            .map_err(db_error)?;
            job.id = i32::try_from(tx.last_insert_rowid()).map_err(db_error)?;
            tx.execute(
                "UPDATE reminder_jobs SET payload=?1 WHERE id=?2",
                params![serde_json::to_string(job).map_err(db_error)?, job.id],
            )
            .map_err(db_error)?;
        } else {
            tx.execute(
                "INSERT INTO reminder_jobs (id,user_id,game_uid,payload) VALUES (?1,?2,?3,?4)",
                params![
                    job.id,
                    user,
                    uid,
                    serde_json::to_string(job).map_err(db_error)?
                ],
            )
            .map_err(db_error)?;
        }
    }
    tx.commit().map_err(db_error)
}
fn role_name(app: &AppHandle, user: i64, uid: &str) -> ApiResult<String> {
    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    let users = store::list(&conn).map_err(db_error)?;
    users
        .iter()
        .find(|u| u.id == user)
        .and_then(|u| u.game_roles.iter().find(|r| r.game_uid == uid))
        .map(|r| format!("{} · {}", r.nickname, r.game_uid))
        .ok_or_else(|| ApiError::retcode(-6, "用户没有该游戏角色"))
}
fn roles(app: &AppHandle) -> ApiResult<Vec<(i64, String)>> {
    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT user_id,game_uid FROM reminder_profiles")
        .map_err(db_error)?;
    let list = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    Ok(list)
}
fn load(app: &AppHandle, user: i64, uid: &str) -> ApiResult<(Profile, Vec<Job>)> {
    read(&app.state::<AppState>().db.lock().unwrap(), user, uid)
}
fn save(app: &AppHandle, user: i64, uid: &str, p: &Profile, jobs: &mut [Job]) -> ApiResult<()> {
    write(
        &mut app.state::<AppState>().db.lock().unwrap(),
        user,
        uid,
        p,
        jobs,
    )
}
fn cancel(app: &AppHandle, ids: Vec<i32>) -> ApiResult<()> {
    #[cfg(mobile)]
    if !ids.is_empty() {
        app.notification().cancel(ids).map_err(notify_error)?;
    }
    #[cfg(desktop)]
    let _ = (app, ids); // 桌面没有系统定时任务，停止进程即停止检查。
    Ok(())
}
#[cfg(windows)]
fn show_windows(identifier: &str, title: &str, body: &str) -> ApiResult<()> {
    // 官方插件桌面端会丢弃后台 show 的错误。使用相同底层库，保留真实失败供反馈诊断。
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body).auto_icon();
    let executable = std::env::current_exe().map_err(notify_error)?;
    let development_path = executable
        .parent()
        .is_some_and(|p| p.ends_with("target/debug") || p.ends_with("target/release"));
    if !cfg!(debug_assertions) && !development_path {
        notification.app_id(identifier);
    }
    notification.show().map_err(notify_error)?;
    Ok(())
}
fn show_now(app: &AppHandle, title: &str, body: &str) -> ApiResult<()> {
    #[cfg(windows)]
    {
        show_windows(&app.config().identifier, title, body)
    }
    #[cfg(not(windows))]
    {
        let builder = app.notification().builder().title(title).body(body);
        #[cfg(target_os = "android")]
        let builder = builder.channel_id("recovery").icon("ic_stat_reminder");
        builder.show().map_err(notify_error)
    }
}
fn deliver(app: &AppHandle, job: &Job, name: &str, scheduled: bool) -> ApiResult<()> {
    let (title, body) = job.text(name);
    #[cfg(windows)]
    {
        let _ = scheduled;
        show_now(app, &title, &body)
    }
    #[cfg(not(windows))]
    {
        let builder = app
            .notification()
            .builder()
            .id(job.id)
            .title(title)
            .body(body)
            .extra("source", "recovery-reminder");
        #[cfg(target_os = "android")]
        let builder = builder.channel_id("recovery").icon("ic_stat_reminder");
        #[cfg(mobile)]
        let builder = if scheduled {
            let date = time::OffsetDateTime::from_unix_timestamp_nanos(
                i128::from(job.due_at_ms) * 1_000_000,
            )
            .map_err(notify_error)?;
            builder.schedule(tauri_plugin_notification::Schedule::At {
                date,
                repeating: false,
                allow_while_idle: true,
            })
        } else {
            builder
        };
        #[cfg(desktop)]
        let _ = scheduled;
        builder.show().map_err(notify_error)
    }
}
fn prepare_channel(app: &AppHandle) -> ApiResult<()> {
    #[cfg(target_os = "android")]
    app.notification()
        .create_channel(
            tauri_plugin_notification::Channel::builder("recovery", "资源恢复提醒")
                .description("树脂、洞天宝钱与探索派遣提醒")
                .build(),
        )
        .map_err(notify_error)?;
    let _ = app;
    Ok(())
}

/// 调用方持有 ReminderGate；入库和原生操作之间不持有数据库锁。
fn reconcile(
    app: &AppHandle,
    user: i64,
    uid: &str,
    settings: Option<Settings>,
    note: Option<DailyNoteData>,
    restore: bool,
) -> ApiResult<Status> {
    let name = role_name(app, user, uid)?;
    let (mut p, old) = load(app, user, uid)?;
    if let Some(n) = note {
        p.snapshot = Some(n);
        p.settings.adapt_defaults(p.snapshot.as_ref());
    }
    if let Some(mut s) = settings {
        s.validate(p.snapshot.as_ref())
            .map_err(|e| ApiError::retcode(-6, e))?;
        p.settings = s;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut jobs = p
        .snapshot
        .as_ref()
        .map(|n| engine::plan(&p.settings, n, &old, now))
        .unwrap_or_default();
    let cancelled: Vec<_> = old
        .iter()
        .filter(|previous| {
            previous.scheduled
                && ((restore && !previous.delivered && previous.due_at_ms > now)
                    || !jobs.iter().any(|j| j.id == previous.id && j.scheduled))
        })
        .map(|j| j.id)
        .collect();
    cancel(app, cancelled)?;
    for job in &mut jobs {
        if restore && !job.delivered && job.due_at_ms > now {
            job.scheduled = false;
        }
        // 只重新安排未来通知；已到期的安卓通知保留给系统投递，不清除通知栏里的未读提醒。
        if restore && job.due_at_ms <= now {
            job.delivered = true;
        }
    }
    p.error = None;
    save(app, user, uid, &p, &mut jobs)?;
    #[cfg(mobile)]
    {
        if p.settings.active() {
            let permitted = matches!(
                app.notification().permission_state(),
                Ok(tauri::plugin::PermissionState::Granted)
            );
            if !permitted {
                p.error = Some("系统通知权限未开启，提醒暂时无法发送".into());
            } else if let Err(e) = prepare_channel(app) {
                log::warn!(
                    "[reminder] 通知类别初始化失败 retcode={} message={}",
                    e.code,
                    e.message
                );
                p.error = Some(e.message);
            } else {
                for job in jobs
                    .iter_mut()
                    .filter(|j| !j.delivered && !j.scheduled && j.due_at_ms > now)
                {
                    match deliver(app, job, &name, true) {
                        Ok(()) => {
                            job.scheduled = true;
                            log::info!(
                                "[reminder] 已安排 uid={uid} kind={} value={} at={}",
                                job.kind,
                                job.value,
                                job.due_at_ms
                            );
                        }
                        Err(e) => {
                            log::warn!(
                                "[reminder] 安排失败 retcode={} message={}",
                                e.code,
                                e.message
                            );
                            p.error = Some(e.message);
                        }
                    }
                }
            }
        }
        save(app, user, uid, &p, &mut jobs)?;
    }
    #[cfg(desktop)]
    let _ = name;
    Ok(Status {
        settings: p.settings,
        snapshot: p.snapshot,
        jobs,
        error: p.error,
    })
}

pub async fn observe(app: &AppHandle, user: i64, uid: &str, note: DailyNoteData) {
    let gate = app.state::<ReminderGate>();
    let _guard = gate.0.lock().await;
    let result = reconcile(app, user, uid, None, Some(note), false);
    report("更新提醒计划", &result);
}
#[tauri::command]
pub async fn reminder_status(
    handle: AppHandle,
    user_id: i64,
    game_uid: String,
) -> ApiResult<Status> {
    log::info!("[reminder] 读取设置 user_id={user_id} uid={game_uid}");
    let gate = handle.state::<ReminderGate>();
    let _guard = gate.0.lock().await;
    let result = (|| {
        role_name(&handle, user_id, &game_uid)?;
        let (p, jobs) = load(&handle, user_id, &game_uid)?;
        Ok(Status {
            settings: p.settings,
            snapshot: p.snapshot,
            jobs,
            error: p.error,
        })
    })();
    report("读取设置", &result);
    result
}
#[tauri::command]
pub async fn reminder_save(
    handle: AppHandle,
    user_id: i64,
    game_uid: String,
    settings: Settings,
) -> ApiResult<Status> {
    log::info!(
        "[reminder] 保存设置 user_id={user_id} uid={game_uid} resin={} coin={} expeditions={}",
        settings.resin.enabled,
        settings.home_coin.enabled,
        settings.expeditions
    );
    let gate = handle.state::<ReminderGate>();
    let _guard = gate.0.lock().await;
    let result = reconcile(&handle, user_id, &game_uid, Some(settings), None, false);
    report("保存设置", &result);
    result
}
#[tauri::command]
pub async fn reminder_test(handle: AppHandle) -> ApiResult<()> {
    log::info!("[reminder] 发送测试通知");
    let result = (|| {
        prepare_channel(&handle)?;
        show_now(
            &handle,
            "提醒已准备好",
            "这是一条测试通知。树脂、洞天宝钱和派遣提醒会在这里出现。",
        )
    })();
    report("发送测试通知", &result);
    result
}
#[tauri::command]
pub async fn reminder_resume(handle: AppHandle) -> ApiResult<()> {
    log::info!("[reminder] 恢复提醒调度");
    let result = resume(&handle, cfg!(mobile)).await;
    report("恢复提醒调度", &result);
    result
}
async fn resume(handle: &AppHandle, restore: bool) -> ApiResult<()> {
    let gate = handle.state::<ReminderGate>();
    let _guard = gate.0.lock().await;
    for (user, uid) in roles(handle)? {
        reconcile(handle, user, &uid, None, None, restore)?;
    }
    Ok(())
}
pub async fn remove_user(app: &AppHandle, user: i64) -> ApiResult<()> {
    let gate = app.state::<ReminderGate>();
    let _guard = gate.0.lock().await;
    for (id, uid) in roles(app)?.into_iter().filter(|(id, _)| *id == user) {
        let (_, jobs) = load(app, id, &uid)?;
        cancel(app, jobs.iter().map(|j| j.id).collect())?;
    }
    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM reminder_jobs WHERE user_id=?1", [user])
        .map_err(db_error)?;
    conn.execute("DELETE FROM reminder_profiles WHERE user_id=?1", [user])
        .map_err(db_error)?;
    log::info!("[reminder] 已清除账号提醒 user_id={user}");
    Ok(())
}
async fn tick(app: &AppHandle) -> ApiResult<()> {
    let gate = app.state::<ReminderGate>();
    let _guard = gate.0.lock().await;
    let now = chrono::Utc::now().timestamp_millis();
    for (user, uid) in roles(app)? {
        let (mut p, mut jobs) = load(app, user, &uid)?;
        let name = match role_name(app, user, &uid) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let mut changed = false;
        for job in jobs
            .iter_mut()
            .filter(|j| !j.delivered && j.due_at_ms <= now)
        {
            // 睡眠/进程暂停超过五分钟后不集中补发过时提醒。
            #[cfg(desktop)]
            let should_send = now - job.due_at_ms <= 5 * 60 * 1000;
            #[cfg(mobile)]
            let should_send = !job.scheduled && now - job.due_at_ms <= 5 * 60 * 1000;
            if should_send {
                if let Err(e) = deliver(app, job, &name, false) {
                    log::warn!(
                        "[reminder] 通知发送失败 uid={uid} retcode={} message={}",
                        e.code,
                        e.message
                    );
                    p.error = Some(e.message);
                    changed = true;
                    continue;
                }
            }
            job.delivered = true;
            changed = true;
            log::info!(
                "[reminder] 提醒到期 uid={uid} kind={} value={}",
                job.kind,
                job.value
            );
        }
        if changed {
            save(app, user, &uid, &p, &mut jobs)?;
        }
    }
    Ok(())
}
pub fn start(app: AppHandle) {
    let timer = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = resume(&timer, true).await {
            log::warn!(
                "[reminder] 启动恢复失败 retcode={} message={}",
                e.code,
                e.message
            );
        }
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if let Err(e) = tick(&timer).await {
                log::warn!(
                    "[reminder] 到期检查失败 retcode={} message={}",
                    e.code,
                    e.message
                );
            }
        }
    });
    // 与通知走针分离：网络超时不会阻塞到期通知，风控时保留已有计划，不弹验证。
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            if let Ok(list) = roles(&app) {
                for (user, uid) in list {
                    if !load(&app, user, &uid)
                        .map(|(p, _)| p.settings.active())
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    if let Err(e) = crate::commands::daily_note(
                        app.state(),
                        app.clone(),
                        user,
                        uid.clone(),
                        None,
                    )
                    .await
                    {
                        log::warn!(
                            "[reminder] 后台同步失败 uid={uid} retcode={} message={}",
                            e.code,
                            e.message
                        );
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(8 * 60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stored_snapshot_retains_timestamp_and_can_schedule_after_restart() {
        let mut conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let p = Profile {
            snapshot: Some(DailyNoteData {
                fetched_at_ms: now,
                current_resin: 100,
                max_resin: 200,
                resin_recovery_time: 48000,
                ..Default::default()
            }),
            ..Default::default()
        };
        write(&mut conn, 1, "100", &p, &mut []).unwrap();
        let (mut restored, _) = read(&conn, 1, "100").unwrap();
        assert_eq!(restored.snapshot.as_ref().unwrap().fetched_at_ms, now);
        restored.settings.resin.enabled = true;
        let jobs = engine::plan(
            &restored.settings,
            restored.snapshot.as_ref().unwrap(),
            &[],
            now,
        );
        assert_eq!(jobs.len(), 3);
        assert!(jobs.iter().all(|j| j.due_at_ms > now));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "发送一条 Windows 系统通知，仅手动验证时运行"]
    fn windows_system_notification_smoke() {
        show_windows(
            "com.learnrepo.hoyoauth",
            "霜舞工具箱 · 通知测试",
            "这是一条系统通知。树脂、洞天宝钱和派遣提醒会在这里出现。",
        )
        .unwrap();
    }
    #[test]
    fn persistence_keeps_role_isolation_and_notification_ids() {
        let mut conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let mut p = Profile::default();
        p.settings.resin.enabled = true;
        let mut jobs = vec![Job {
            id: 0,
            kind: "resin".into(),
            value: 180,
            due_at_ms: 123,
            anchor_at_ms: 123,
            delivered: false,
            scheduled: false,
        }];
        write(&mut conn, 1, "100", &p, &mut jobs).unwrap();
        let first = jobs[0].id;
        write(&mut conn, 1, "100", &p, &mut jobs).unwrap();
        assert_eq!(jobs[0].id, first);
        assert!(read(&conn, 2, "100").unwrap().1.is_empty());
        assert!(read(&conn, 1, "200").unwrap().1.is_empty());
        let mut second = jobs.clone();
        second[0].id = 0;
        write(&mut conn, 2, "100", &p, &mut second).unwrap();
        assert_ne!(second[0].id, first);
        jobs[0].delivered = true;
        write(&mut conn, 1, "100", &p, &mut jobs).unwrap();
        assert!(read(&conn, 1, "100").unwrap().1[0].delivered);
    }
}
