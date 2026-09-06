//! 实时便签（对应原版 Web/Hoyolab/Takumi/GameRecord/DailyNote + GameRecordClient）。
//!
//! 请求规格与原版 GetDailyNoteAsync 一致：
//! - GET {record-host}/game_record/app/genshin/api/dailyNote?role_id={uid}&server={region}
//! - Profile::XRpc（client_type=5）+ Cookie(cookie_token+ltoken) + 设备指纹
//! - Referer webstatic + x-rpc-tool_verison: v5.0.1-ys + DS Gen2(X4, 数字 r)
//!
//! 原版遇到 retcode 1034 会拉起极验 WebView 验证后重试；
//! 此处直接把风控信息透传给前端提示（复刻版不内置极验）。

use crate::constants::{self, Salts};
use crate::http::{self, Devices, DsSpec, Profile, RequestSpec};
use crate::models::{de_f64_flexible, de_i32_flexible, de_i64_flexible};
use crate::response::{unwrap_envelope, ApiError, ApiResult};
use crate::store::UserRecord;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 数据模型（字段名与米哈游 JSON 完全一致，对应 DailyNote/DailyNoteCommon 等）
// 注意：该接口大量数字字段以字符串返回，统一使用弹性反序列化
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DailyNoteData {
    /// 原粹树脂
    #[serde(deserialize_with = "de_i32_flexible")]
    pub current_resin: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub max_resin: i32,
    /// 距离回满的秒数
    #[serde(deserialize_with = "de_i64_flexible")]
    pub resin_recovery_time: i64,

    /// 每日委托（顶层字段，部分版本在 daily_task 内）
    #[serde(deserialize_with = "de_i32_flexible")]
    pub finished_task_num: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub total_task_num: i32,
    pub is_extra_task_reward_received: bool,

    /// 周本减半次数已用/剩余
    #[serde(deserialize_with = "de_i32_flexible")]
    pub remain_resin_discount_num: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub resin_discount_num_limit: i32,

    /// 洞天宝钱（尘歌壶未开时 max 为 0）
    #[serde(deserialize_with = "de_i32_flexible")]
    pub current_home_coin: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub max_home_coin: i32,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub home_coin_recovery_time: i64,

    /// 探索派遣
    #[serde(deserialize_with = "de_i32_flexible")]
    pub current_expedition_num: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub max_expedition_num: i32,
    pub expeditions: Vec<Expedition>,

    /// 参量质变仪
    pub transformer: Option<Transformer>,

    /// 新版每日委托结构（含旅行札记进度）
    pub daily_task: Option<DailyTask>,

    /// 魔神任务进度
    pub archon_quest_progress: Option<ArchonQuestProgress>,

    #[serde(skip_deserializing, default)]
    pub fetched_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Expedition {
    /// 角色侧面头像 URL（upload-bbs CDN）
    pub avatar_side_icon: String,
    /// Finished | Ongoing
    pub status: String,
    /// 剩余秒数
    #[serde(deserialize_with = "de_i64_flexible")]
    pub remained_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Transformer {
    pub obtained: bool,
    pub recovery_time: Option<RecoveryTime>,
}

/// 注意：该结构的字段米哈游以大写返回，对外序列化统一为小写
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RecoveryTime {
    #[serde(rename(serialize = "day", deserialize = "Day"), deserialize_with = "de_i32_flexible")]
    pub day: i32,
    #[serde(rename(serialize = "hour", deserialize = "Hour"), deserialize_with = "de_i32_flexible")]
    pub hour: i32,
    #[serde(rename(serialize = "minute", deserialize = "Minute"), deserialize_with = "de_i32_flexible")]
    pub minute: i32,
    #[serde(rename(serialize = "second", deserialize = "Second"), deserialize_with = "de_i32_flexible")]
    pub second: i32,
    pub reached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DailyTask {
    #[serde(deserialize_with = "de_i32_flexible")]
    pub total_num: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub finished_num: i32,
    pub is_extra_task_reward_received: bool,
    /// 旅行札记（PC 端每日签到替代）；米哈游以字符串返回浮点（"382.7"）
    pub attendance_visible: bool,
    #[serde(deserialize_with = "de_f64_flexible")]
    pub stored_attendance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ArchonQuestProgress {
    pub list: Vec<ArchonQuest>,
    pub is_open_archon_quest: bool,
    pub is_finish_all_mainline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ArchonQuest {
    /// StatusFinished | StatusOngoing | StatusNotOpen
    pub status: String,
    /// 第X章
    pub chapter_num: String,
    pub chapter_title: String,
}

// ---------------------------------------------------------------------------
// API（对应 GameRecordClient.GetDailyNoteAsync / GameRecordClientOversea）
// ---------------------------------------------------------------------------

/// 组合 CookieType.Cookie（cookie_token;ltoken），对应 SetUserCookieAndFpHeader
pub(crate) fn combined_cookie(user: &UserRecord) -> ApiResult<String> {
    let cookie_token = user
        .cookie_token
        .as_ref()
        .ok_or_else(|| ApiError::retcode(-3, "缺少 cookie_token，请先刷新 Cookie"))?;
    let ltoken = user
        .ltoken
        .as_ref()
        .ok_or_else(|| ApiError::retcode(-3, "缺少 ltoken，请重新登录"))?;
    Ok(format!("{cookie_token};{ltoken}"))
}

/// GameRecord 系接口的公共请求规格：XRpc + 组合 Cookie + 指纹 + webstatic Referer + DS Gen2(X4)
pub(crate) fn record_spec(user: &UserRecord, url: String, method: reqwest::Method, body: Option<serde_json::Value>) -> ApiResult<RequestSpec> {
    let mut spec = match (method, body) {
        (reqwest::Method::POST, Some(b)) => RequestSpec::post(url, Profile::XRpc, b),
        _ => RequestSpec::get(url, Profile::XRpc),
    }
    .with_cookie_raw(combined_cookie(user)?)
    .with_referer(constants::webstatic_referer(user.is_oversea))
    .with_header("x-rpc-tool_verison", constants::TOOL_VERSION_GR)
    .with_ds(DsSpec::Gen2 {
        salt: if user.is_oversea {
            constants::SALT_OS_X4.to_string()
        } else {
            constants::SALT_CN_X4.to_string()
        },
        include_chars: false,
        is_prod_body: false,
    });
    if let Some(fp) = user.fingerprint.as_deref().filter(|f| !f.is_empty()) {
        spec = spec.with_device_fp(fp);
    }
    Ok(spec)
}

/// 拉取实时便签。xrpc_challenge 来自安全验证（createVerification→verifyVerification），
/// 带上后可绕过账号风控标记（对应原版 RetryIf1034Async 的重试请求）。
pub async fn fetch(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
    uid: &str,
    region: &str,
    xrpc_challenge: Option<&str>,
) -> ApiResult<DailyNoteData> {
    let url = constants::url_daily_note(uid, region, user.is_oversea);
    let mut spec = record_spec(user, url, reqwest::Method::GET, None)?;
    if let Some(challenge) = xrpc_challenge {
        spec = spec.with_header("x-rpc-challenge", challenge);
    }

    // 响应 data 即便签本体；个别形态会再包一层 daily_note（小组件源），两者都兼容
    let resp = match http::request::<serde_json::Value>(client, salts, devices, spec).await {
        Ok(r) => r,
        Err(e) if e.code == 1034 || e.code == 5003 => {
            // 账号级风控标记（原版 KnownReturnCode 注释：当前账号存在风险）
            return Err(ApiError::retcode(
                e.code,
                "当前账号被标记风险，需要完成安全验证后重试",
            ));
        }
        Err(e) => return Err(e),
    };
    let value = unwrap_envelope(resp.envelope, "dailyNote")?;
    let mut note: DailyNoteData = if value.get("daily_note").is_some() {
        serde_json::from_value(value["daily_note"].clone())
            .map_err(|e| ApiError::transport(format!("dailyNote 解析失败: {e}")))?
    } else {
        serde_json::from_value(value)
            .map_err(|e| ApiError::transport(format!("dailyNote 解析失败: {e}")))?
    };
    note.fetched_at_ms = crate::service::now_ms();
    Ok(note)
}

// ---------------------------------------------------------------------------
// 安全验证（对应 CardClient.CreateVerificationAsync / VerifyVerificationAsync
//          + GeetestService.TryVerifyXrpcChallengeAsync）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct GeetestVerificationDto {
    pub gt: String,
    pub challenge: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct VerificationResultDto {
    challenge: String,
}

/// 第一步：向米哈游申请极验验证会话，返回 gt/challenge 供前端渲染滑块。
/// is_high=false：与 gsuid_core 等社区实现对齐（game_record 链路用普通难度题目；
/// is_high=true 的高风险题经人工滑块解出后会被 verifyVerification 判 10306）
pub async fn create_verification(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
) -> ApiResult<GeetestVerificationDto> {
    let url = "https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/createVerification?is_high=false".to_string();
    let spec = record_spec(user, url, reqwest::Method::GET, None)?
        .with_header("x-rpc-challenge_game", "2")
        .with_header("x-rpc-challenge_path", constants::DAILY_NOTE_PATH_CN);
    let resp = http::request::<GeetestVerificationDto>(client, salts, devices, spec).await?;
    let data = unwrap_envelope(resp.envelope, "createVerification")?;
    if data.gt.is_empty() || data.challenge.is_empty() {
        return Err(ApiError::empty_data("gt/challenge"));
    }
    Ok(data)
}

/// 第三步：提交极验结果换取 xrpc-challenge（第二步的人工滑块在前端完成）
pub async fn verify_verification(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
    challenge: &str,
    validate: &str,
) -> ApiResult<String> {
    let body = serde_json::json!({
        "geetest_challenge": challenge,
        "geetest_validate": validate,
        "geetest_seccode": format!("{validate}|jordan"),
    });
    let spec = record_spec(
        user,
        "https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/verifyVerification".to_string(),
        reqwest::Method::POST,
        Some(body),
    )?
    .with_header("x-rpc-challenge_game", "2")
    .with_header("x-rpc-challenge_path", constants::DAILY_NOTE_PATH_CN);
    let resp = http::request::<VerificationResultDto>(client, salts, devices, spec).await?;
    let data = unwrap_envelope(resp.envelope, "verifyVerification")?;
    if data.challenge.is_empty() {
        return Err(ApiError::empty_data("challenge"));
    }
    Ok(data.challenge)
}
