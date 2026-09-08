//! 米哈游 API 数据模型（字段名与原版各 *Wrapper/*.cs 的 JsonPropertyName 一致）。
//! 所有字段宽松解析，避免服务端增删字段导致反序列化失败。

use serde::{Deserialize, Serialize};

/// 兼容反序列化：米哈游部分接口把数字字段以字符串返回（如 gacha_type:"200"）
pub fn de_i32_flexible<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(deserializer)?;
    match v {
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(|x| x as i32)
            .ok_or_else(|| serde::de::Error::custom("invalid number")),
        serde_json::Value::String(s) => s
            .parse::<i32>()
            .map_err(|_| serde::de::Error::custom(format!("invalid numeric string: {s}"))),
        serde_json::Value::Null => Ok(0),
        other => Err(serde::de::Error::custom(format!("expected number or string, got {other}"))),
    }
}

/// 同上，i64 版本（雪花 ID 等大整数以字符串返回）
pub fn de_i64_flexible<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(deserializer)?;
    match v {
        serde_json::Value::Number(n) => n
            .as_i64()
            .ok_or_else(|| serde::de::Error::custom("invalid number")),
        serde_json::Value::String(s) => s
            .parse::<i64>()
            .map_err(|_| serde::de::Error::custom(format!("invalid numeric string: {s}"))),
        serde_json::Value::Null => Ok(0),
        other => Err(serde::de::Error::custom(format!("expected number or string, got {other}"))),
    }
}

/// 同上，f64 版本（实时便签 stored_attendance:"382.7" 等浮点以字符串返回）
pub fn de_f64_flexible<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(deserializer)?;
    match v {
        serde_json::Value::Number(n) => n
            .as_f64()
            .ok_or_else(|| serde::de::Error::custom("invalid number")),
        serde_json::Value::String(s) => s
            .parse::<f64>()
            .map_err(|_| serde::de::Error::custom(format!("invalid numeric string: {s}"))),
        serde_json::Value::Null => Ok(0.0),
        other => Err(serde::de::Error::custom(format!("expected number or string, got {other}"))),
    }
}

fn empty_str() -> String {
    String::new()
}

// ---------------------------------------------------------------------------
// Passport（登录）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct QrLogin {
    #[serde(default = "empty_str")]
    pub url: String,
    #[serde(default = "empty_str")]
    pub ticket: String,
}

#[derive(Debug, Deserialize)]
pub struct TokenWrapper {
    #[serde(default)]
    pub token_type: i32,
    #[serde(default = "empty_str")]
    pub token: String,
}

#[derive(Debug, Deserialize)]
pub struct UserInformation {
    #[serde(default = "empty_str")]
    pub aid: String,
    #[serde(default = "empty_str")]
    pub mid: String,
}

#[derive(Debug, Deserialize)]
pub struct QrLoginResult {
    /// Created | Scanned | Confirmed | Expired
    #[serde(default = "empty_str")]
    pub status: String,
    #[serde(default)]
    pub tokens: Vec<TokenWrapper>,
    #[serde(default)]
    pub user_info: Option<UserInformation>,
}

#[derive(Debug, Deserialize)]
pub struct LoginResult {
    #[serde(default)]
    pub token: Option<TokenWrapper>,
    #[serde(default)]
    pub user_info: Option<UserInformation>,
}

#[derive(Debug, Deserialize)]
pub struct UidCookieToken {
    /// 服务端返回的 uid（与 aid 一致，登录链路未使用，协议字段保留）
    #[serde(default = "empty_str")]
    #[allow(dead_code)]
    pub uid: String,
    #[serde(default = "empty_str")]
    pub cookie_token: String,
}


#[derive(Debug, Deserialize)]
pub struct LTokenData {
    #[serde(default = "empty_str", rename = "ltoken")]
    pub ltoken: String,
}

#[derive(Debug, Deserialize)]
pub struct MobileCaptchaData {
    #[serde(default = "empty_str", rename = "action_type")]
    pub action_type: String,
    #[serde(default)]
    pub countdown: i64,
}

// ---------------------------------------------------------------------------
// 用户信息 / 游戏角色
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
pub struct BbsUserInfo {
    #[serde(default = "empty_str")]
    pub uid: String,
    #[serde(default = "empty_str")]
    pub nickname: String,
    /// 头像 ID（数字，不可直接作为图片地址）
    #[serde(default = "empty_str")]
    #[allow(dead_code)]
    pub avatar: String,
    /// 头像完整 URL（前端展示用）
    #[serde(default = "empty_str")]
    pub avatar_url: String,
}

#[derive(Debug, Deserialize)]
pub struct UserFullInfoWrapper {
    #[serde(default)]
    pub user_info: Option<BbsUserInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameRole {
    #[serde(default = "empty_str")]
    pub game_biz: String,
    #[serde(default = "empty_str")]
    pub region: String,
    #[serde(default = "empty_str")]
    pub game_uid: String,
    #[serde(default = "empty_str")]
    pub nickname: String,
    #[serde(default)]
    pub level: i32,
}

#[derive(Debug, Deserialize)]
pub struct GameRoleList {
    #[serde(default)]
    pub list: Vec<GameRole>,
}

#[derive(Debug, Deserialize)]
pub struct ActionTicketData {
    #[serde(default = "empty_str")]
    pub ticket: String,
}

// ---------------------------------------------------------------------------
// 设备指纹
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct DeviceFpResult {
    #[serde(default = "empty_str", rename = "device_fp")]
    pub device_fp: String,
}

// ---------------------------------------------------------------------------
// Salt 分发端点
// ---------------------------------------------------------------------------

// SaltLatestEnvelope / SaltLatestData 定义在 constants.rs
