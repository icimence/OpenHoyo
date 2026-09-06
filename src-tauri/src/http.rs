//! HTTP 层：封装各客户端伪装头（对应原版 HttpClientConfiguration XRpc2/3/5/6 + Default）、
//! Cookie 注入、DS 签名与响应信封解析。

use crate::constants::{self, Salts};
use crate::ds::{self, DsBody};
use crate::response::{ApiError, ApiResult, Envelope};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;

/// 请求头伪装档位
#[derive(Debug, Clone, Copy)]
pub enum Profile {
    /// 米游社登录客户端（XRpc2，client_type=2）
    XRpc2,
    /// 米游社 App 通用（XRpc：client_type=5，takumi 接口如 genAuthKey）
    XRpc,
    /// 国内 HoyoPlay 启动器（XRpc5，二维码登录用）
    XRpc5,
    /// HoYoLAB App（XRpc3）
    XRpc3,
    /// 国际 HoyoPlay（XRpc6，预留给国际服密码/三方登录）
    #[allow(dead_code)]
    XRpc6,
    /// 通用（takumi/bbs 接口，仅 UA + Accept）
    Bbs,
}

/// 设备标识：进程生命周期内保持不变（对应原版 HoyolabOptions.DeviceId36/53）
#[derive(Debug, Clone)]
pub struct Devices {
    pub id36: String,
    pub id53: String,
}

impl Devices {
    pub fn new() -> Self {
        Self {
            id36: uuid::Uuid::new_v4().to_string(),
            id53: crate::random::lower_alnum(53),
        }
    }

    /// 复用持久化的 device_id36（保持与已绑定指纹一致）
    pub fn with_id36(id36: String) -> Self {
        Self {
            id36,
            id53: crate::random::lower_alnum(53),
        }
    }
}

/// DS 签名规格
pub enum DsSpec {
    /// Gen1 + 指定 salt（如 K2）
    Gen1 { salt: String, include_chars: bool },
    /// Gen2 + 指定 salt（如 PROD）
    Gen2 { salt: String, include_chars: bool, is_prod_body: bool },
}

pub struct RequestSpec {
    pub url: String,
    pub profile: Profile,
    pub method: reqwest::Method,
    pub query_body: Option<Value>,
    pub cookie: Option<String>,
    pub device_fp: Option<String>,
    pub referer: Option<&'static str>,
    pub ds: Option<DsSpec>,
    /// 覆盖默认 device_id 头（二维码登录显式传 id53）
    pub device_id_override: Option<String>,
    /// 额外请求头（如风控会话 x-rpc-aigis）
    pub extra_headers: Vec<(String, String)>,
}

impl RequestSpec {
    pub fn get(url: impl Into<String>, profile: Profile) -> Self {
        Self {
            url: url.into(),
            profile,
            method: reqwest::Method::GET,
            query_body: None,
            cookie: None,
            device_fp: None,
            referer: None,
            ds: None,
            device_id_override: None,
            extra_headers: Vec::new(),
        }
    }

    pub fn post(url: impl Into<String>, profile: Profile, body: Value) -> Self {
        Self {
            url: url.into(),
            profile,
            method: reqwest::Method::POST,
            query_body: Some(body),
            cookie: None,
            device_fp: None,
            referer: None,
            ds: None,
            device_id_override: None,
            extra_headers: Vec::new(),
        }
    }

    pub fn with_cookie(mut self, cookie: &crate::cookie::Cookie) -> Self {
        self.cookie = Some(cookie.to_string());
        self
    }

    /// 直接注入原始 Cookie 串（实时便签等需要拼接多组凭证的场景）
    pub fn with_cookie_raw(mut self, cookie: String) -> Self {
        self.cookie = Some(cookie);
        self
    }

    pub fn with_device_fp(mut self, fp: &str) -> Self {
        self.device_fp = Some(fp.to_string());
        self
    }

    pub fn with_ds(mut self, spec: DsSpec) -> Self {
        self.ds = Some(spec);
        self
    }

    pub fn with_referer(mut self, referer: &'static str) -> Self {
        self.referer = Some(referer);
        self
    }

    pub fn with_device_id(mut self, id: String) -> Self {
        self.device_id_override = Some(id);
        self
    }

    pub fn with_header(mut self, key: &str, value: impl Into<String>) -> Self {
        self.extra_headers.push((key.to_string(), value.into()));
        self
    }
}

/// 带额外响应头信息的响应
pub struct HoyoResponse<T> {
    pub envelope: Envelope<T>,
    /// 响应头 X-Rpc-Aigis（触发极验风控时非空）
    pub aigis: Option<String>,
}

pub async fn request<T: DeserializeOwned>(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    spec: RequestSpec,
) -> ApiResult<HoyoResponse<T>> {
    // 请求追踪：query 中可能含 authkey/stoken 等凭证，日志只保留路径
    let started = std::time::Instant::now();
    let url_path = spec.url.split('?').next().unwrap_or(&spec.url).to_string();
    log::info!("[http] {} {}", spec.method, url_path);

    let body_str = spec
        .query_body
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_default());

    let mut req = client
        .request(spec.method.clone(), &spec.url)
        .timeout(Duration::from_secs(20));

    req = apply_profile(req, spec.profile, salts, devices);

    if let Some(id) = &spec.device_id_override {
        req = req.header("x-rpc-device_id", id);
    }
    if let Some(cookie) = &spec.cookie {
        req = req.header(reqwest::header::COOKIE, cookie);
    }
    if let Some(fp) = &spec.device_fp {
        req = req.header("x-rpc-device_fp", fp);
    }
    if let Some(referer) = spec.referer {
        req = req.header(reqwest::header::REFERER, referer);
    }
    if let Some(ds_spec) = &spec.ds {
        let ds_value = match ds_spec {
            DsSpec::Gen1 { salt, include_chars } => ds::ds_gen1(salt, *include_chars),
            DsSpec::Gen2 { salt, include_chars, is_prod_body } => ds::ds_gen2(
                salt,
                *include_chars,
                match body_str.as_deref() {
                    Some(b) => DsBody::Raw(b),
                    None => DsBody::None { is_prod: *is_prod_body },
                },
                ds::query_of(&spec.url),
            ),
        };
        req = req.header("DS", ds_value);
    }

    for (key, value) in &spec.extra_headers {
        req = req.header(key.as_str(), value.as_str());
    }

    if let Some(body) = &body_str {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.clone());
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[http] {} {} → 网络错误: {e}", spec.method, url_path);
            return Err(ApiError::transport(e.to_string()));
        }
    };
    let aigis = resp
        .headers()
        .get("X-Rpc-Aigis")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let status = resp.status();
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            log::warn!("[http] {} {} → 读取响应失败: HTTP {status}, {e}", spec.method, url_path);
            return Err(ApiError::transport(format!("HTTP {status}, {e}")));
        }
    };
    let envelope: Envelope<T> = match serde_json::from_slice(&bytes) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[http] {} {} → 响应解析失败: HTTP {status}, {e}", spec.method, url_path);
            return Err(ApiError::transport(format!("HTTP {status}, 响应解析失败: {e}")));
        }
    };

    if envelope.retcode == 0 {
        log::info!(
            "[http] {} {} → OK（{}ms）",
            spec.method,
            url_path,
            started.elapsed().as_millis()
        );
    } else {
        log::warn!(
            "[http] {} {} → retcode={} {}（{}ms）",
            spec.method,
            url_path,
            envelope.retcode,
            envelope.message,
            started.elapsed().as_millis()
        );
    }

    Ok(HoyoResponse { envelope, aigis })
}

fn apply_profile(req: reqwest::RequestBuilder, profile: Profile, salts: &Salts, devices: &Devices) -> reqwest::RequestBuilder {
    let mut req = req.header(reqwest::header::ACCEPT, "application/json");
    match profile {
        Profile::XRpc2 => {
            req = req
                .header(reqwest::header::USER_AGENT, salts.cn_user_agent())
                .header("x-rpc-aigis", "")
                .header("x-rpc-app_id", constants::APP_ID_BBS)
                .header("x-rpc-app_version", &salts.cn_version)
                .header("x-rpc-client_type", "2")
                .header("x-rpc-device_id", &devices.id36)
                .header("x-rpc-device_name", "")
                .header("x-rpc-game_biz", "bbs_cn")
                .header("x-rpc-sdk_version", "2.16.0");
        }
        Profile::XRpc => {
            req = req
                .header(reqwest::header::USER_AGENT, salts.cn_user_agent())
                .header("x-rpc-app_version", &salts.cn_version)
                .header("x-rpc-client_type", "5")
                .header("x-rpc-device_id", &devices.id36);
        }
        Profile::XRpc5 => {
            req = req
                .header(reqwest::header::USER_AGENT, constants::HOYOPLAY_USER_AGENT)
                .header("x-rpc-app_id", constants::APP_ID_HYP_CN)
                .header("x-rpc-client_type", "3");
        }
        Profile::XRpc3 => {
            req = req
                .header(reqwest::header::USER_AGENT, salts.os_user_agent())
                .header("x-rpc-app_version", &salts.os_version)
                .header("x-rpc-client_type", "5")
                .header("x-rpc-language", "zh-cn")
                .header("x-rpc-device_id", &devices.id36);
        }
        Profile::XRpc6 => {
            req = req
                .header(reqwest::header::USER_AGENT, constants::HOYOPLAY_USER_AGENT)
                .header("x-rpc-app_id", constants::APP_ID_HYP_OS)
                .header("x-rpc-client_type", "3")
                .header("x-rpc-device_id", &devices.id53);
        }
        Profile::Bbs => {
            req = req.header(reqwest::header::USER_AGENT, salts.cn_user_agent());
        }
    }
    req
}
