//! Tauri IPC 命令层：前端 ↔ 后端的唯一入口。

use crate::cookie::{self, Cookie};
use crate::models::QrLoginResult;
use crate::passport;
use crate::response::{ApiError, ApiResult};
use crate::service::{self, UserDto};
use crate::state::{salts, AppState};
use crate::store::{self, UserRecord};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn list_users(state: State<'_, AppState>) -> ApiResult<Vec<UserDto>> {
    let db = state.db.lock().unwrap();
    let records = store::list(&db).map_err(|e| ApiError::retcode(-4, format!("数据库错误: {e}")))?;
    drop(db);
    Ok(records.iter().map(UserDto::from).collect())
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct QrCreateDto {
    pub ticket: String,
    /// 二维码 SVG，前端直接 innerHTML
    pub svg: String,
}

#[tauri::command]
pub async fn qr_login_create(state: State<'_, AppState>) -> ApiResult<QrCreateDto> {
    let salts = salts(&state).await;
    let qr = passport::create_qr_login(&state.http, &salts, &state.devices).await?;

    // 本地生成二维码 SVG（对应原版 QRCoder）
    let code = qrcode::QrCode::new(qr.url.as_bytes())
        .map_err(|e| ApiError::transport(format!("二维码生成失败: {e}")))?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();

    Ok(QrCreateDto {
        ticket: qr.ticket,
        svg: svg.trim_start_matches(['\u{feff}', '\n']).to_string(),
    })
}

#[derive(Serialize)]
pub struct QrPollDto {
    /// Init=等待扫码 | Scanned=已扫码 | Confirmed=已确认 | Expired=已过期
    pub status: String,
    pub user: Option<UserDto>,
}

#[tauri::command]
pub async fn qr_login_poll(
    state: State<'_, AppState>,
    handle: AppHandle,
    ticket: String,
) -> ApiResult<QrPollDto> {
    let salts = salts(&state).await;
    let result: QrLoginResult = passport::query_qr_login_status(&state.http, &salts, &state.devices, &ticket).await?;

    if result.status == "Confirmed" {
        // token_type == 1 即 stoken（对应原版 Tokens.Single(t => t.TokenType is 1)）
        let stoken = result
            .tokens
            .iter()
            .find(|t| t.token_type == 1)
            .map(|t| t.token.clone())
            .ok_or_else(|| ApiError::empty_data("tokens[token_type=1]"))?;
        let user_info = result
            .user_info
            .ok_or_else(|| ApiError::empty_data("user_info"))?;

        let cookie = cookie::build_stoken_cookie(&user_info.aid, &user_info.mid, &stoken);
        let user = service::login_with_stoken(&state, &handle, cookie, false).await?;
        return Ok(QrPollDto { status: "Confirmed".into(), user: Some(user) });
    }

    Ok(QrPollDto {
        status: result.status,
        user: None,
    })
}

// ---------------------------------------------------------------------------
// 手机验证码登录
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CaptchaSendDto {
    pub action_type: String,
    pub countdown: i64,
}

#[tauri::command]
pub async fn mobile_captcha_send(state: State<'_, AppState>, mobile: String) -> ApiResult<CaptchaSendDto> {
    let salts = salts(&state).await;
    // aigis 风控在 passport 层检测：触发时返回带提示的错误
    let (data, _) = passport::create_login_captcha(&state.http, &salts, &state.devices, &mobile, None).await?;

    Ok(CaptchaSendDto {
        action_type: data.action_type,
        countdown: data.countdown,
    })
}

#[tauri::command]
pub async fn mobile_captcha_login(
    state: State<'_, AppState>,
    handle: AppHandle,
    mobile: String,
    captcha: String,
    action_type: String,
) -> ApiResult<UserDto> {
    let salts = salts(&state).await;
    let result = passport::login_by_mobile_captcha(&state.http, &salts, &state.devices, &mobile, &captcha, &action_type, None).await?;

    let token = result
        .token
        .ok_or_else(|| ApiError::empty_data("token"))?;
    let user_info = result
        .user_info
        .ok_or_else(|| ApiError::empty_data("user_info"))?;

    let cookie = cookie::build_stoken_cookie(&user_info.aid, &user_info.mid, &token.token);
    service::login_with_stoken(&state, &handle, cookie, false).await
}

// ---------------------------------------------------------------------------
// Cookie 导入
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cookie_login(
    state: State<'_, AppState>,
    handle: AppHandle,
    raw: String,
    is_oversea: bool,
) -> ApiResult<UserDto> {
    let cookie = Cookie::parse(&raw);
    let stoken = cookie
        .stoken()
        .ok_or_else(|| ApiError::retcode(-3, "Cookie 无效：需要同时包含 stuid、mid、stoken"))?;

    service::login_with_stoken(&state, &handle, stoken, is_oversea).await
}

// ---------------------------------------------------------------------------
// 用户管理
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn remove_user(state: State<'_, AppState>, handle: AppHandle, id: i64) -> ApiResult<()> {
    {
        let db = state.db.lock().unwrap();
        store::delete(&db, id).map_err(|e| ApiError::retcode(-4, format!("数据库错误: {e}")))?;
    }
    let _ = handle.emit("users://changed", ());
    Ok(())
}

/// 手动刷新某个用户的 cookie_token（对应原版 RefreshCookieTokenCommand）
#[tauri::command]
pub async fn refresh_cookie_token(
    state: State<'_, AppState>,
    handle: AppHandle,
    id: i64,
) -> ApiResult<UserDto> {
    let mut rec = {
        let db = state.db.lock().unwrap();
        let records = store::list(&db).map_err(|e| ApiError::retcode(-4, format!("数据库错误: {e}")))?;
        records
            .into_iter()
            .find(|r: &UserRecord| r.id == id)
            .ok_or_else(|| ApiError::retcode(-5, "用户不存在"))?
    };

    let salts = salts(&state).await;
    let data = passport::get_cookie_token_by_stoken(&state.http, &salts, &state.devices, &rec).await?;
    rec.cookie_token = Some(cookie::build_cookie_token_cookie(&rec.aid, &data.cookie_token));
    rec.cookie_token_updated_at = service::now_ms();

    service::save(&state, &mut rec)?;
    let _ = handle.emit("users://changed", ());
    Ok(UserDto::from(&rec))
}

/// 导出用户完整 Cookie（对应原版 CopyCookieCommand）
#[tauri::command]
pub async fn export_user_cookies(state: State<'_, AppState>, id: i64) -> ApiResult<String> {
    let db = state.db.lock().unwrap();
    let records = store::list(&db).map_err(|e| ApiError::retcode(-4, format!("数据库错误: {e}")))?;
    drop(db);
    let rec = records
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| ApiError::retcode(-5, "用户不存在"))?;
    Ok(rec.full_cookie_string())
}

// ---------------------------------------------------------------------------
// 祈愿记录
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct GachaArchiveDto {
    pub id: i64,
    pub uid: String,
}

#[tauri::command]
pub async fn gacha_archives(state: State<'_, AppState>) -> ApiResult<Vec<GachaArchiveDto>> {
    Ok(crate::gacha::list_archives(&state)?
        .into_iter()
        .map(|(id, uid)| GachaArchiveDto { id, uid })
        .collect())
}

#[tauri::command]
pub async fn gacha_statistics(state: State<'_, AppState>, archive_id: i64) -> ApiResult<crate::gacha_stats::GachaStatisticsDto> {
    let items = crate::gacha::load_items(&state, archive_id)?;
    let uid = crate::gacha::list_archives(&state)?
        .into_iter()
        .find(|(id, _)| *id == archive_id)
        .map(|(_, uid)| uid)
        .ok_or_else(|| ApiError::retcode(-5, "存档不存在"))?;
    Ok(crate::gacha_stats::build_statistics(&uid, &items))
}

#[tauri::command]
pub async fn gacha_remove_archive(state: State<'_, AppState>, archive_id: i64) -> ApiResult<()> {
    crate::gacha::remove_archive(&state, archive_id)
}

/// SToken 刷新：需要当前用户与其游戏角色（对应原版 GachaLogQuerySTokenProvider）
#[tauri::command]
pub async fn gacha_refresh_by_stoken(
    state: State<'_, AppState>,
    handle: AppHandle,
    user_id: i64,
    game_uid: String,
) -> ApiResult<String> {
    let rec = {
        let db = state.db.lock().unwrap();
        let records = store::list(&db).map_err(|e| ApiError::retcode(-4, format!("数据库错误: {e}")))?;
        records
            .into_iter()
            .find(|r| r.id == user_id)
            .ok_or_else(|| ApiError::retcode(-5, "用户不存在"))?
    };
    let role = rec
        .game_roles
        .iter()
        .find(|r| r.game_uid == game_uid)
        .cloned()
        .ok_or_else(|| ApiError::retcode(-6, "用户没有该游戏角色"))?;

    let salts = salts(&state).await;
    let query = crate::gacha::build_query_from_stoken(&state, &salts, &rec, &role).await?;
    crate::gacha::refresh_gacha_log(&state, &handle, &query, rec.is_oversea, false).await
}

/// 网页缓存刷新（对应原版 GachaLogQueryWebCacheProvider）
#[tauri::command]
pub async fn gacha_refresh_by_web_cache(
    state: State<'_, AppState>,
    handle: AppHandle,
) -> ApiResult<String> {
    let query = crate::gacha::build_query_from_web_cache()?;
    let is_oversea = query.contains("region=os_");
    crate::gacha::refresh_gacha_log(&state, &handle, &query, is_oversea, false).await
}

/// 手动输入刷新（对应原版 GachaLogQueryManualInputProvider）
#[tauri::command]
pub async fn gacha_refresh_by_manual(
    state: State<'_, AppState>,
    handle: AppHandle,
    input: String,
    aggressive: bool,
) -> ApiResult<String> {
    let query = crate::gacha::build_query_from_manual(&input)?;
    let is_oversea = query.contains("region=os_");
    crate::gacha::refresh_gacha_log(&state, &handle, &query, is_oversea, false).await
}

// ---------------------------------------------------------------------------
// 实时便签
// ---------------------------------------------------------------------------

fn find_user(state: &State<'_, AppState>, user_id: i64) -> ApiResult<UserRecord> {
    let db = state.db.lock().unwrap();
    let records = store::list(&db).map_err(|e| ApiError::retcode(-4, format!("数据库错误: {e}")))?;
    records
        .into_iter()
        .find(|r| r.id == user_id)
        .ok_or_else(|| ApiError::retcode(-5, "用户不存在"))
}

/// 拉取实时便签（对应原版 DailyNoteService.RefreshDailyNoteAsync：先懒刷新凭证再请求）
#[tauri::command]
pub async fn daily_note(
    state: State<'_, AppState>,
    user_id: i64,
    game_uid: String,
    challenge: Option<String>,
) -> ApiResult<crate::daily_note::DailyNoteData> {
    let mut rec = find_user(&state, user_id)?;
    let role = rec
        .game_roles
        .iter()
        .find(|r| r.game_uid == game_uid)
        .cloned()
        .ok_or_else(|| ApiError::retcode(-6, "用户没有该游戏角色"))?;

    // 懒刷新 cookie_token/ltoken（超过 1 天自动用 SToken 重换）。
    // 注意：这里绝不广播 users://changed —— 那会触发前端整页重载→再次请求→事件回环
    if let Err(e) = service::initialize_user(&state, &mut rec, false).await {
        // 凭证刷新失败不必然致命（本地可能仍有有效缓存凭证），记录后继续尝试
        eprintln!("[daily_note] 凭证刷新失败: {e}");
    } else {
        let _ = service::save(&state, &mut rec);
    }

    let salts = salts(&state).await;
    crate::daily_note::fetch(
        &state.http,
        &salts,
        &state.devices,
        &rec,
        &role.game_uid,
        &role.region,
        challenge.as_deref(),
    )
    .await
}

/// 安全验证第一步：申请极验会话（对应 CardClient.CreateVerificationAsync）
#[tauri::command]
pub async fn card_create_verification(
    state: State<'_, AppState>,
    user_id: i64,
) -> ApiResult<crate::daily_note::GeetestVerificationDto> {
    let rec = find_user(&state, user_id)?;
    let salts = salts(&state).await;
    crate::daily_note::create_verification(&state.http, &salts, &state.devices, &rec).await
}

/// 安全验证第三步：提交滑块结果换 xrpc-challenge（对应 CardClient.VerifyVerificationAsync）
#[tauri::command]
pub async fn card_verify_verification(
    state: State<'_, AppState>,
    user_id: i64,
    challenge: String,
    validate: String,
) -> ApiResult<String> {
    let rec = find_user(&state, user_id)?;
    let salts = salts(&state).await;
    crate::daily_note::verify_verification(&state.http, &salts, &state.devices, &rec, &challenge, &validate).await
}

// ---------------------------------------------------------------------------
// 周期挑战记录（深境螺旋/幻想真境剧诗/幽境危战）
// ---------------------------------------------------------------------------

async fn prepare_record_user(state: &State<'_, AppState>, user_id: i64, game_uid: &str) -> ApiResult<(UserRecord, crate::models::GameRole)> {
    let mut rec = find_user(state, user_id)?;
    let role = rec
        .game_roles
        .iter()
        .find(|r| r.game_uid == game_uid)
        .cloned()
        .ok_or_else(|| ApiError::retcode(-6, "用户没有该游戏角色"))?;
    if let Err(e) = service::initialize_user(state, &mut rec, false).await {
        eprintln!("[game_record] 凭证刷新失败: {e}");
    } else {
        let _ = service::save(state, &mut rec);
    }
    Ok((rec, role))
}

/// 深境螺旋：schedule_type 1=本期 2=上期
#[tauri::command]
pub async fn spiral_abyss(
    state: State<'_, AppState>,
    user_id: i64,
    game_uid: String,
    schedule_type: u8,
    challenge: Option<String>,
) -> ApiResult<crate::game_record::SpiralAbyss> {
    let (rec, role) = prepare_record_user(&state, user_id, &game_uid).await?;
    let salts = salts(&state).await;
    crate::game_record::fetch_spiral_abyss(
        &state.http,
        &salts,
        &state.devices,
        &rec,
        &role.game_uid,
        &role.region,
        schedule_type,
        challenge.as_deref(),
    )
    .await
}

/// 幻想真境剧诗
#[tauri::command]
pub async fn role_combat(
    state: State<'_, AppState>,
    user_id: i64,
    game_uid: String,
    challenge: Option<String>,
) -> ApiResult<crate::game_record::RoleCombat> {
    let (rec, role) = prepare_record_user(&state, user_id, &game_uid).await?;
    let salts = salts(&state).await;
    crate::game_record::fetch_role_combat(
        &state.http,
        &salts,
        &state.devices,
        &rec,
        &role.game_uid,
        &role.region,
        challenge.as_deref(),
    )
    .await
}

/// 幽境危战
#[tauri::command]
pub async fn hard_challenge(
    state: State<'_, AppState>,
    user_id: i64,
    game_uid: String,
    challenge: Option<String>,
) -> ApiResult<crate::game_record::HardChallenge> {
    let (rec, role) = prepare_record_user(&state, user_id, &game_uid).await?;
    let salts = salts(&state).await;
    crate::game_record::fetch_hard_challenge(
        &state.http,
        &salts,
        &state.devices,
        &rec,
        &role.game_uid,
        &role.region,
        challenge.as_deref(),
    )
    .await
}
