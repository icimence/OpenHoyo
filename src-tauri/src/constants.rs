//! 米哈游协议常量：salt、版本、端点、UA、RSA 公钥。
//!
//! salt/版本的默认值取自 https://internal.gentle.house/Archive/Salt/Latest
//! （原 Snap.Hutao 的 SaltConstantGenerator 在编译期拉取同一端点），
//! 本项目改为运行时刷新 + 内置兜底。

use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct Salts {
    pub cn_version: String,
    pub os_version: String,
    pub cn_k2: String,
    pub cn_lk2: String,
    pub os_k2: String,
    pub os_lk2: String,
}

/// 2026-09-05 从 salt 分发端点拉取的内置默认值（见 `impl Default`）

impl Default for Salts {
    fn default() -> Self {
        Self {
            cn_version: "2.114.0".to_string(),
            os_version: "4.20.0".to_string(),
            cn_k2: "d64014da690671f8704695e993130f4c".to_string(),
            cn_lk2: "21d2764ed385827b2005dc5d38b2a844".to_string(),
            os_k2: "599uqkwc0dlqu3h6epzjzfhgyyrd44ae".to_string(),
            os_lk2: "rk4xg2hakoi26nljpr099fv9fck1ah10".to_string(),
        }
    }
}

// 以下 salt 不参与轮换，原版即硬编码在 HoyolabOptions.cs 中
// （X4/X6 预留给战绩/签到等接口，登录链路暂未使用）
#[allow(dead_code)]
pub const SALT_CN_X4: &str = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
#[allow(dead_code)]
pub const SALT_CN_X6: &str = "t0qEgfub6cvueAPgR5m9aQWWVciEer7v";
pub const SALT_CN_PROD: &str = "JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS";
#[allow(dead_code)]
pub const SALT_OS_X4: &str = "h4c1d6ywfq5bsbnbhm1bzq7bxzzv6srt";
#[allow(dead_code)]
pub const SALT_OS_X6: &str = "okr4obncj8bw5a65hbnn5oo6ixjc3l9w";

pub const SALT_LATEST_URL: &str = "https://internal.gentle.house/Archive/Salt/Latest";

#[derive(Deserialize)]
pub struct SaltLatestEnvelope {
    #[serde(default)]
    pub data: Option<SaltLatestData>,
}

#[derive(Deserialize)]
pub struct SaltLatestData {
    #[serde(rename = "CNVersion", default)]
    pub cn_version: String,
    #[serde(rename = "OSVersion", default)]
    pub os_version: String,
    #[serde(rename = "CNK2", default)]
    pub cn_k2: String,
    #[serde(rename = "CNLK2", default)]
    pub cn_lk2: String,
    #[serde(rename = "OSK2", default)]
    pub os_k2: String,
    #[serde(rename = "OSLK2", default)]
    pub os_lk2: String,
}

// ---------------------------------------------------------------------------
// UserAgent（对应原版 HoyolabOptions）
// ---------------------------------------------------------------------------

pub const HOYOPLAY_USER_AGENT: &str = "HYPContainer/1.1.4.133";

impl Salts {
    pub fn cn_user_agent(&self) -> String {
        format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/{}", self.cn_version)
    }

    pub fn os_user_agent(&self) -> String {
        format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBSOversea/{}", self.os_version)
    }
}

// ---------------------------------------------------------------------------
// Header 常量（对应原版各 HttpClientConfiguration）
// ---------------------------------------------------------------------------

pub const APP_ID_BBS: &str = "bll8iq97cem8"; // XRpc2 米游社客户端
pub const APP_ID_HYP_CN: &str = "ddxf5dufpuyo"; // XRpc5 国内 HoyoPlay
pub const APP_ID_HYP_OS: &str = "ddxf6vlr1reo"; // XRpc6 国际 HoyoPlay

// ---------------------------------------------------------------------------
// 端点（对应原版 ApiEndpoints.csv，仅保留登录链路所需）
// ---------------------------------------------------------------------------

pub fn url_create_qr_login() -> String {
    "https://passport-api.mihoyo.com/account/ma-cn-passport/app/createQRLogin".into()
}

pub fn url_query_qr_login_status() -> String {
    "https://passport-api.mihoyo.com/account/ma-cn-passport/app/queryQRLoginStatus".into()
}

pub fn url_create_login_captcha() -> String {
    "https://passport-api.mihoyo.com/account/ma-cn-verifier/verifier/createLoginCaptcha".into()
}

pub fn url_login_by_mobile_captcha() -> String {
    "https://passport-api.mihoyo.com/account/ma-cn-passport/app/loginByMobileCaptcha".into()
}

pub fn url_get_cookie_token_by_stoken(is_oversea: bool) -> String {
    if is_oversea {
        "https://api-account-os.hoyoverse.com/account/auth/api/getCookieAccountInfoBySToken".into()
    } else {
        "https://passport-api.mihoyo.com/account/auth/api/getCookieAccountInfoBySToken".into()
    }
}

pub fn url_get_ltoken_by_stoken(is_oversea: bool) -> String {
    if is_oversea {
        "https://api-account-os.hoyoverse.com/account/auth/api/getLTokenBySToken".into()
    } else {
        "https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken".into()
    }
}

pub fn url_user_full_info(aid: &str, is_oversea: bool) -> String {
    if is_oversea {
        "https://bbs-api-os.hoyolab.com/community/painter/wapi/user/full".into()
    } else {
        format!("https://bbs-api.mihoyo.com/user/wapi/getUserFullInfo?uid={aid}&gids=2")
    }
}

pub const BBS_REFERER_CN: &str = "https://bbs.mihoyo.com/";

pub fn url_action_ticket(stoken: &str, aid: &str) -> String {
    format!(
        "https://api-takumi.mihoyo.com/auth/api/getActionTicketBySToken?action_type=game_role&stoken={stoken}&uid={aid}"
    )
}

pub fn url_game_roles_by_action_ticket(ticket: &str) -> String {
    format!("https://api-takumi.mihoyo.com/binding/api/getUserGameRoles?action_ticket={ticket}&game_biz=hk4e_cn")
}

pub const URL_GAME_ROLES_BY_COOKIE_OS: &str =
    "https://api-account-os.hoyoverse.com/binding/api/getUserGameRolesByCookie?game_biz=hk4e_global";

pub const URL_DEVICE_FP: &str = "https://public-data-api.mihoyo.com/device-fp/api/getFp";

// 实时便签（GameRecord）：对应 ApiEndpoints.csv GameRecordDailyNote 行
pub fn url_daily_note(uid: &str, server: &str, is_oversea: bool) -> String {
    if is_oversea {
        format!("https://bbs-api-os.hoyolab.com/game_record/app/genshin/api/dailyNote?role_id={uid}&server={server}")
    } else {
        format!("https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/dailyNote?role_id={uid}&server={server}")
    }
}

pub fn webstatic_referer(is_oversea: bool) -> &'static str {
    if is_oversea {
        "https://webstatic-sea.mihoyo.com"
    } else {
        "https://webstatic.mihoyo.com"
    }
}

/// GameRecord 请求的 x-rpc-tool_verison（对应 GameRecordClient 中硬编码值）
pub const TOOL_VERSION_GR: &str = "v5.0.1-ys";

// ---------------------------------------------------------------------------
// 国服 Passport 接口 RSA 公钥（UIGF 社区文档公开值，用于手机号加密）
// ---------------------------------------------------------------------------

pub const CN_PASSPORT_RSA_PUBLIC_KEY: &str = r#"
-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDvekdPMHN3AYhm/vktJT+YJr7
cI5DcsNKqdsx5DZX0gDuWFuIjzdwButrIYPNmRJ1G8ybDIF7oDW2eEpm5sMbL9zs
9ExXCdvqrn51qELbqj0XxtMTIpaCHFSI50PfPpTFV9Xt/hmyVwokoOXFlAEgCn+Q
CgGs52bFoYMtyi+xEQIDAQAB
-----END PUBLIC KEY-----
"#;

// ---------------------------------------------------------------------------
// 区服显示名
// ---------------------------------------------------------------------------

pub fn region_name(region: &str) -> String {
    match region {
        "cn_gf01" => "国服·天空岛".into(),
        "cn_qd01" => "国服·世界树".into(),
        "os_usa" => "国际服·美洲".into(),
        "os_euro" => "国际服·欧洲".into(),
        "os_asia" => "国际服·亚太".into(),
        "os_cht" => "国际服·港澳台".into(),
        other => other.to_string(),
    }
}
