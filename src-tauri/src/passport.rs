//! Passport 登录接口（对应原版 PassportClient / HoyoPlayPassportClient）。

use crate::constants::{self, Salts};
use crate::http::{self, Devices, DsSpec, Profile, RequestSpec};
use crate::models::{LoginResult, MobileCaptchaData, QrLogin, QrLoginResult, UidCookieToken, LTokenData};
use crate::response::{unwrap_envelope, ApiError, ApiResult};
use crate::store::UserRecord;
use base64::Engine;
use rand::rngs::OsRng;
use rsa::pkcs1v15::Pkcs1v15Encrypt;
use rsa::pkcs8::DecodePublicKey;
use rsa::RsaPublicKey;
use serde::Serialize;
use serde_json::json;

/// RSA 加密手机号等敏感字段（PKCS1v15，与原版 PassportClient.Encrypt 一致）
pub fn rsa_encrypt_cn(source: &str) -> ApiResult<String> {
    let key = RsaPublicKey::from_public_key_pem(constants::CN_PASSPORT_RSA_PUBLIC_KEY)
        .map_err(|e| ApiError::transport(format!("RSA 公钥加载失败: {e}")))?;
    let mut rng = OsRng;
    let cipher = key
        .encrypt(&mut rng, Pkcs1v15Encrypt, source.as_bytes())
        .map_err(|e| ApiError::transport(format!("RSA 加密失败: {e}")))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(cipher))
}

/// 生成二维码登录（对应 CreateQrLoginAsync，XRpc5 伪装 HoyoPlay 启动器）
pub async fn create_qr_login(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
) -> ApiResult<QrLogin> {
    let spec = RequestSpec::post(constants::url_create_qr_login(), Profile::XRpc5, json!({}))
        .with_device_id(devices.id53.clone());
    let resp = http::request::<QrLogin>(client, salts, devices, spec).await?;
    unwrap_envelope(resp.envelope, "createQRLogin")
}

/// 轮询二维码状态（对应 QueryQrLoginStatusAsync）
pub async fn query_qr_login_status(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    ticket: &str,
) -> ApiResult<QrLoginResult> {
    let spec = RequestSpec::post(
        constants::url_query_qr_login_status(),
        Profile::XRpc5,
        json!({ "ticket": ticket }),
    )
    .with_device_id(devices.id53.clone());
    let resp = http::request::<QrLoginResult>(client, salts, devices, spec).await?;
    // -3501: 二维码过期
    if resp.envelope.retcode == -3501 {
        return Ok(QrLoginResult {
            status: "Expired".into(),
            tokens: vec![],
            user_info: None,
        });
    }
    unwrap_envelope(resp.envelope, "queryQRLoginStatus")
}

/// 发送登录短信验证码（对应 CreateLoginCaptchaAsync，带 DS Gen2 PROD 签名）。
/// 触发极验风控时返回 Risk（含滑块参数），由前端完成人机验证后带 aigis 重发。
pub async fn create_login_captcha(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    mobile: &str,
    aigis: Option<&str>,
) -> ApiResult<CaptchaStep> {
    let data = json!({
        "area_code": rsa_encrypt_cn("+86")?,
        "mobile": rsa_encrypt_cn(mobile)?,
    });
    let mut spec = RequestSpec::post(constants::url_create_login_captcha(), Profile::XRpc2, data)
        .with_ds(DsSpec::Gen2 {
            salt: constants::SALT_CN_PROD.to_string(),
            include_chars: true,
            is_prod_body: false,
        });
    if let Some(a) = aigis {
        spec = spec.with_header("x-rpc-aigis", a);
    }
    let resp = http::request::<MobileCaptchaData>(client, salts, devices, spec).await?;

    if resp.envelope.retcode != 0 {
        if let Some(risk) = parse_aigis_risk(resp.aigis.as_deref()) {
            log::info!("[passport] 发送验证码触发极验风控（gt={}…），等待前端人机验证", &risk.gt[..risk.gt.len().min(8)]);
            return Ok(CaptchaStep::Risk(risk));
        }
    }

    let data = unwrap_envelope(resp.envelope, "createLoginCaptcha")?;
    Ok(CaptchaStep::Sent(data))
}

/// 短信验证码登录（对应 LoginByMobileCaptchaAsync）。风控处理同上。
pub async fn login_by_mobile_captcha(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    mobile: &str,
    captcha: &str,
    action_type: &str,
    aigis: Option<&str>,
) -> ApiResult<CaptchaLoginStep> {
    let data = json!({
        "area_code": rsa_encrypt_cn("+86")?,
        "action_type": action_type,
        "captcha": captcha,
        "mobile": rsa_encrypt_cn(mobile)?,
    });
    let mut spec = RequestSpec::post(constants::url_login_by_mobile_captcha(), Profile::XRpc2, data)
        .with_ds(DsSpec::Gen2 {
            salt: constants::SALT_CN_PROD.to_string(),
            include_chars: true,
            is_prod_body: false,
        });
    if let Some(a) = aigis {
        spec = spec.with_header("x-rpc-aigis", a);
    }
    let resp = http::request::<LoginResult>(client, salts, devices, spec).await?;
    if resp.envelope.retcode != 0 {
        if let Some(risk) = parse_aigis_risk(resp.aigis.as_deref()) {
            log::info!("[passport] 验证码登录触发极验风控，等待前端人机验证");
            return Ok(CaptchaLoginStep::Risk(risk));
        }
    }
    let result = unwrap_envelope(resp.envelope, "loginByMobileCaptcha")?;
    Ok(CaptchaLoginStep::Ok(result))
}

/// 极验风控参数：由前端加载极验滑块，完成后组 aigis 头重发请求
#[derive(Debug, Clone, Serialize)]
pub struct CaptchaRisk {
    /// 风控会话 ID，回传 aigis 头的第一段
    pub session_id: String,
    /// 极验 GT3 参数
    pub gt: String,
    /// 极验 GT3 参数
    pub challenge: String,
}

pub enum CaptchaStep {
    Sent(MobileCaptchaData),
    Risk(CaptchaRisk),
}

pub enum CaptchaLoginStep {
    Ok(LoginResult),
    Risk(CaptchaRisk),
}

/// 解析风控响应头 X-Rpc-Aigis：
/// `{"session_id":"...","mmt_type":1,"data":"{\"gt\":\"...\",\"challenge\":\"...\",...}"}`
/// （data 是字符串化的 JSON）
fn parse_aigis_risk(raw: Option<&str>) -> Option<CaptchaRisk> {
    let raw = raw?;
    #[derive(serde::Deserialize)]
    struct AigisSession {
        session_id: String,
        #[serde(default)]
        #[allow(dead_code)]
        mmt_type: i32,
        data: String,
    }
    #[derive(serde::Deserialize)]
    struct GeetestVerification {
        gt: String,
        challenge: String,
    }
    let session: AigisSession = serde_json::from_str(raw).ok()?;
    let geetest: GeetestVerification = serde_json::from_str(&session.data).ok()?;
    if geetest.gt.is_empty() || geetest.challenge.is_empty() {
        return None;
    }
    Some(CaptchaRisk {
        session_id: session.session_id,
        gt: geetest.gt,
        challenge: geetest.challenge,
    })
}

/// 用 SToken 换取 cookie_token（对应 GetCookieAccountInfoBySTokenAsync；
/// 国服 GET + DS 签名，国际服 POST {stoken, uid}）
pub async fn get_cookie_token_by_stoken(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
) -> ApiResult<UidCookieToken> {
    let resp = if user.is_oversea {
        let stoken = user
            .stoken
            .get(crate::cookie::STOKEN)
            .ok_or_else(|| ApiError::retcode(-3, "缺少 stoken"))?;
        let data = json!({ "stoken": stoken, "uid": user.aid });
        let spec = RequestSpec::post(constants::url_get_cookie_token_by_stoken(true), Profile::XRpc3, data)
            .with_cookie(user.stoken());
        http::request::<UidCookieToken>(client, salts, devices, spec).await?
    } else {
        let mut spec = RequestSpec::get(constants::url_get_cookie_token_by_stoken(false), Profile::XRpc2)
            .with_cookie(user.stoken())
            .with_ds(DsSpec::Gen2 {
                salt: constants::SALT_CN_PROD.to_string(),
                include_chars: true,
                is_prod_body: true,
            });
        if let Some(fp) = user.fingerprint.as_deref().filter(|f| !f.is_empty()) {
            spec = spec.with_device_fp(fp);
        }
        http::request::<UidCookieToken>(client, salts, devices, spec).await?
    };
    unwrap_envelope(resp.envelope, "getCookieAccountInfoBySToken")
}

/// 用 SToken 换取 ltoken（对应 GetLTokenBySTokenAsync）
pub async fn get_ltoken_by_stoken(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
) -> ApiResult<LTokenData> {
    let resp = if user.is_oversea {
        let stoken = user
            .stoken
            .get(crate::cookie::STOKEN)
            .ok_or_else(|| ApiError::retcode(-3, "缺少 stoken"))?;
        let data = json!({ "stoken": stoken, "uid": user.aid });
        let spec = RequestSpec::post(constants::url_get_ltoken_by_stoken(true), Profile::XRpc3, data)
            .with_cookie(user.stoken());
        http::request::<LTokenData>(client, salts, devices, spec).await?
    } else {
        let mut spec = RequestSpec::get(constants::url_get_ltoken_by_stoken(false), Profile::XRpc2)
            .with_cookie(user.stoken())
            .with_ds(DsSpec::Gen2 {
                salt: constants::SALT_CN_PROD.to_string(),
                include_chars: true,
                is_prod_body: true,
            });
        if let Some(fp) = user.fingerprint.as_deref().filter(|f| !f.is_empty()) {
            spec = spec.with_device_fp(fp);
        }
        http::request::<LTokenData>(client, salts, devices, spec).await?
    };
    unwrap_envelope(resp.envelope, "getLTokenBySToken")
}

#[cfg(test)]
mod tests {
    use super::parse_aigis_risk;

    /// 风控响应头样例（格式对应原版 AigisSession/GeetestVerification，data 为字符串化 JSON）
    #[test]
    fn parses_aigis_risk_header() {
        let raw = r#"{"session_id":"0cb5abf3-56f1-4f8f-a1aa-0d5a5c9a5a2b","mmt_type":1,"data":"{\"success\":1,\"gt\":\"549cc6b0d8e0a1f4e6e8d4b0e4e6f4e4\",\"challenge\":\"c7e0d4b8a1c8e4f2a9d3e0f4c6d2a8e6\",\"new_captcha\":1}"}"#;
        let risk = parse_aigis_risk(Some(raw)).expect("应解析出风控参数");
        assert_eq!(risk.session_id, "0cb5abf3-56f1-4f8f-a1aa-0d5a5c9a5a2b");
        assert_eq!(risk.gt, "549cc6b0d8e0a1f4e6e8d4b0e4e6f4e4");
        assert_eq!(risk.challenge, "c7e0d4b8a1c8e4f2a9d3e0f4c6d2a8e6");
    }

    #[test]
    fn rejects_non_risk_aigis() {
        assert!(parse_aigis_risk(None).is_none());
        // 空风控参数（未触发）
        assert!(parse_aigis_risk(Some(r#"{"session_id":"x","data":"{\"gt\":\"\",\"challenge\":\"\"}"}"#)).is_none());
        // 非 JSON
        assert!(parse_aigis_risk(Some("garbage")).is_none());
    }
}
