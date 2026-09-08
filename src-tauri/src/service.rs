//! 登录与凭证编排（对应原版 UserService.ProcessInputCookieAsync +
//! UserInitializationService.InitializeUserAsync 的完整凭证链）。
//!
//! SToken 是根凭证；LToken/CookieToken/设备指纹按需兑换并按时间戳懒刷新：
//! cookie_token 超过 1 天、fingerprint 超过 7 天即重换。

use crate::constants::{self, region_name};
use crate::cookie::{self, Cookie};
use crate::models::GameRole;
use crate::passport;
use crate::response::{ApiError, ApiResult};
use crate::state::{salts, AppState};
use crate::store::{self, UserRecord};
use crate::{device_fp, user_api};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const COOKIE_TOKEN_TTL_MS: i64 = 24 * 60 * 60 * 1000; // 1 天
const FINGERPRINT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 7 天

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 前端 DTO
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct GameRoleDto {
    pub game_uid: String,
    pub nickname: String,
    pub level: i32,
    pub region: String,
    pub region_name: String,
    pub game_biz: String,
}

#[derive(Serialize, Clone)]
pub struct UserDto {
    pub id: i64,
    pub aid: String,
    pub mid: String,
    pub is_oversea: bool,
    pub nickname: Option<String>,
    pub uid: Option<String>,
    pub avatar: Option<String>,
    pub region_name: Option<String>,
    pub game_roles: Vec<GameRoleDto>,
    pub cookie_token_updated_at: i64,
    pub fingerprint_updated_at: i64,
}

impl From<&UserRecord> for UserDto {
    fn from(rec: &UserRecord) -> Self {
        let roles = rec
            .game_roles
            .iter()
            .map(|r: &GameRole| GameRoleDto {
                game_uid: r.game_uid.clone(),
                nickname: r.nickname.clone(),
                level: r.level,
                region: r.region.clone(),
                region_name: region_name(&r.region),
                game_biz: r.game_biz.clone(),
            })
            .collect();
        Self {
            id: rec.id,
            aid: rec.aid.clone(),
            mid: rec.mid.clone(),
            is_oversea: rec.is_oversea,
            nickname: rec.nickname.clone(),
            uid: rec.uid.clone(),
            avatar: rec.avatar.clone(),
            region_name: rec.game_roles.first().map(|r| region_name(&r.region)),
            game_roles: roles,
            cookie_token_updated_at: rec.cookie_token_updated_at,
            fingerprint_updated_at: rec.fingerprint_updated_at,
        }
    }
}

fn emit_users_changed(handle: &tauri::AppHandle) {
    let _ = handle.emit("users://changed", ());
}

// ---------------------------------------------------------------------------
// 登录入口
// ---------------------------------------------------------------------------

/// 由 SToken Cookie（登录产物或用户粘贴）创建/更新用户并初始化凭证链
pub async fn login_with_stoken(
    state: &AppState,
    handle: &tauri::AppHandle,
    stoken_cookie: Cookie,
    is_oversea: bool,
) -> ApiResult<UserDto> {
    log::info!("[user] 登录流程开始（{}）", if is_oversea { "HoYoLAB" } else { "米游社" });
    let stuid = stoken_cookie
        .get(cookie::STUID)
        .ok_or_else(|| ApiError::retcode(-3, "Cookie 缺少 stuid"))?
        .clone();
    let mid = stoken_cookie
        .get(cookie::MID)
        .ok_or_else(|| ApiError::retcode(-3, "Cookie 缺少 mid"))?
        .clone();
    if stoken_cookie.get(cookie::STOKEN).is_none() {
        return Err(ApiError::retcode(-3, "Cookie 缺少 stoken"));
    }

    let mut rec = {
        let db = state.db.lock().unwrap();
        match store::find_by_mid(&db, &mid).map_err(db_err)? {
            // 已存在：覆盖根凭证（对应原版 CookieUpdated 分支）
            Some(existing) => UserRecord {
                stoken: stoken_cookie.clone(),
                ..existing
            },
            None => UserRecord {
                id: 0,
                aid: stuid,
                mid: mid.clone(),
                is_oversea,
                stoken: stoken_cookie,
                ltoken: None,
                cookie_token: None,
                fingerprint: None,
                cookie_token_updated_at: 0,
                fingerprint_updated_at: 0,
                nickname: None,
                uid: None,
                avatar: None,
                game_roles: vec![],
            },
        }
    };

    initialize_user(state, &mut rec, true).await?;
    save(state, &mut rec)?;
    emit_users_changed(handle);
    Ok(UserDto::from(&rec))
}

// ---------------------------------------------------------------------------
// 凭证初始化链（对应 InitializeUserAsync 的五步）
// ---------------------------------------------------------------------------

/// `fresh = true` 表示刚登录（cookie_token 必须立即兑换）；
/// `false` 为启动恢复（按时间戳懒刷新）。
pub async fn initialize_user(state: &AppState, rec: &mut UserRecord, fresh: bool) -> ApiResult<()> {
    let salts = salts(state).await;

    // ① LToken：缺失则用 SToken 兑换
    if rec.ltoken.is_none() {
        let data = passport::get_ltoken_by_stoken(&state.http, &salts, &state.devices, rec).await?;
        rec.ltoken = Some(cookie::build_ltoken_cookie(&rec.aid, &data.ltoken));
    }

    // ② CookieToken：刚登录或超过 1 天则用 SToken 兑换
    let need_cookie_token = fresh || rec.cookie_token.is_none() || now_ms() - rec.cookie_token_updated_at > COOKIE_TOKEN_TTL_MS;
    if need_cookie_token {
        let data = passport::get_cookie_token_by_stoken(&state.http, &salts, &state.devices, rec).await?;
        rec.cookie_token = Some(cookie::build_cookie_token_cookie(&rec.aid, &data.cookie_token));
        rec.cookie_token_updated_at = now_ms();
    }

    // ③ 用户信息
    let info = user_api::get_user_full_info(&state.http, &salts, &state.devices, &rec.aid, rec.is_oversea, rec.ltoken.as_ref()).await?;
    if !info.nickname.is_empty() {
        rec.nickname = Some(info.nickname);
    }
    if !info.uid.is_empty() {
        rec.uid = Some(info.uid);
    }
    // 头像：接口的 avatar 是纯数字 ID（不可直接当图片地址），完整 URL 在 avatar_url；
    // 只接受 http 开头的值，避免把 ID 写进记录（存量记录里的 ID 会被这里覆盖）
    let avatar_url = if info.avatar_url.is_empty() { info.avatar.clone() } else { info.avatar_url.clone() };
    if avatar_url.starts_with("http") {
        rec.avatar = Some(avatar_url);
    }

    // ④ 游戏角色
    rec.game_roles = user_api::get_game_roles(&state.http, &salts, &state.devices, rec).await?;

    // ⑤ 设备指纹（仅国服；超过 7 天重换）
    if !rec.is_oversea {
        let need_fp = fresh
            || rec.fingerprint.as_deref().unwrap_or("").is_empty()
            || now_ms() - rec.fingerprint_updated_at > FINGERPRINT_TTL_MS;
        if need_fp {
            if let Ok(fp) = device_fp::get_device_fp(&state.http, &salts, &state.devices).await {
                if !fp.is_empty() {
                    rec.fingerprint = Some(fp);
                    rec.fingerprint_updated_at = now_ms();
                }
            }
            // 指纹失败不阻塞登录（与原版 TryInitializeAsync 的尽力而为语义一致）
        }
    }

    Ok(())
}

/// 启动时恢复所有用户：懒刷新过期凭证后落库（对应 GetUsersAsync → ResumeUserAsync）
pub async fn startup_resume(state: &AppState, handle: &tauri::AppHandle) {
    // 尽力刷新 salt（失败用内置默认值）
    refresh_salts_best_effort(state).await;

    let records = {
        let db = state.db.lock().unwrap();
        store::list(&db).unwrap_or_default()
    };
    log::info!("[startup] 恢复用户：{} 个账号", records.len());

    let mut any_changed = false;
    for mut rec in records {
        match initialize_user(state, &mut rec, false).await {
            Ok(()) => {
                if save(state, &mut rec).is_ok() {
                    any_changed = true;
                }
            }
            Err(e) => {
                log::warn!("[startup] 用户 {} 初始化失败: {e}", rec.mid);
            }
        }
    }
    if any_changed {
        emit_users_changed(handle);
    }
}

/// 从 salt 分发端点刷新（原版在编译期做，这里改为运行时）
async fn refresh_salts_best_effort(state: &AppState) {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
    let Ok(resp) = state.http.get(constants::SALT_LATEST_URL).timeout(TIMEOUT).send().await else {
        return;
    };
    let Ok(envelope) = resp.json::<constants::SaltLatestEnvelope>().await else {
        return;
    };
    let Some(data) = envelope.data else { return };
    if data.cn_k2.is_empty() || data.cn_version.is_empty() {
        return;
    }
    let mut salts = state.salts.write().await;
    salts.cn_version = data.cn_version;
    salts.os_version = data.os_version;
    salts.cn_k2 = data.cn_k2;
    salts.cn_lk2 = data.cn_lk2;
    salts.os_k2 = data.os_k2;
    salts.os_lk2 = data.os_lk2;
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

fn db_err(e: rusqlite::Error) -> ApiError {
    ApiError::retcode(-4, format!("数据库错误: {e}"))
}

pub fn save(state: &AppState, rec: &mut UserRecord) -> ApiResult<()> {
    let db = state.db.lock().unwrap();
    let id = store::upsert(&db, rec).map_err(db_err)?;
    rec.id = id;
    Ok(())
}
