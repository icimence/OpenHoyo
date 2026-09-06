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
use crate::response::{unwrap_envelope, ApiError, ApiResult};
use crate::store::UserRecord;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 数据模型（字段名与米哈游 JSON 完全一致，对应 DailyNote/DailyNoteCommon 等）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DailyNoteData {
    /// 原粹树脂
    pub current_resin: i32,
    pub max_resin: i32,
    /// 距离回满的秒数
    pub resin_recovery_time: i64,

    /// 每日委托（顶层字段，部分版本在 daily_task 内）
    pub finished_task_num: i32,
    pub total_task_num: i32,
    pub is_extra_task_reward_received: bool,

    /// 周本减半次数已用/剩余
    pub remain_resin_discount_num: i32,
    pub resin_discount_num_limit: i32,

    /// 洞天宝钱（尘歌壶未开时 max 为 0）
    pub current_home_coin: i32,
    pub max_home_coin: i32,
    pub home_coin_recovery_time: i64,

    /// 探索派遣
    pub current_expedition_num: i32,
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
    pub remained_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Transformer {
    pub obtained: bool,
    pub recovery_time: Option<RecoveryTime>,
}

/// 注意：该结构的字段在 JSON 中为大写（与米哈游 API 实际返回一致）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RecoveryTime {
    pub day: i32,
    pub hour: i32,
    pub minute: i32,
    pub second: i32,
    pub reached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DailyTask {
    pub total_num: i32,
    pub finished_num: i32,
    pub is_extra_task_reward_received: bool,
    /// 旅行札记（PC 端每日签到替代）
    pub attendance_visible: bool,
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

/// 拉取实时便签。调用方需保证 cookie_token 不过期（service::initialize_user 懒刷新）。
pub async fn fetch(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
    uid: &str,
    region: &str,
) -> ApiResult<DailyNoteData> {
    let url = constants::url_daily_note(uid, region, user.is_oversea);

    // CookieType.Cookie = cookie_token ; ltoken（对应 SetUserCookieAndFpHeader）
    let cookie_token = user
        .cookie_token
        .as_ref()
        .ok_or_else(|| ApiError::retcode(-3, "缺少 cookie_token，请先刷新 Cookie"))?;
    let ltoken = user
        .ltoken
        .as_ref()
        .ok_or_else(|| ApiError::retcode(-3, "缺少 ltoken，请重新登录"))?;
    let cookie = format!("{cookie_token};{ltoken}");

    let mut spec = RequestSpec::get(url, Profile::XRpc)
        .with_cookie_raw(cookie)
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

    // 响应 data 即便签本体；个别形态会再包一层 daily_note（小组件源），两者都兼容
    let resp = match http::request::<serde_json::Value>(client, salts, devices, spec).await {
        Ok(r) => r,
        Err(e) if e.code == 1034 || e.code == 5003 => {
            // 账号级风控标记（原版 KnownReturnCode 注释：当前账号存在风险）
            // 社区通用解法：在米游社 App 中打开一次"实时便签"即可解除
            return Err(ApiError::retcode(
                e.code,
                "当前账号被标记风险，实时便签暂不可用；请在手机米游社 App 中打开一次\"实时便签\"后重试",
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
