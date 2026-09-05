//! 用户信息与游戏角色接口（对应原版 UserClient / BindingClient / AuthClient）。

use crate::constants::{self, Salts};
use crate::cookie::Cookie;
use crate::http::{self, Devices, DsSpec, Profile, RequestSpec};
use crate::models::{ActionTicketData, BbsUserInfo, GameRoleList, UserFullInfoWrapper};
use crate::response::{unwrap_envelope, ApiError, ApiResult};
use crate::store::UserRecord;

/// 拉取米游社用户公开信息（昵称/UID/头像；国服接口无需 Cookie）
pub async fn get_user_full_info(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    aid: &str,
    is_oversea: bool,
    ltoken: Option<&Cookie>,
) -> ApiResult<BbsUserInfo> {
    let mut spec = RequestSpec::get(constants::url_user_full_info(aid, is_oversea), Profile::Bbs);
    if is_oversea {
        spec = match ltoken {
            Some(c) => spec.with_cookie(c),
            None => return Err(ApiError::retcode(-3, "国际服获取用户信息需要 LToken")),
        };
    } else {
        spec = spec.with_referer(constants::BBS_REFERER_CN);
    }

    let resp = http::request::<UserFullInfoWrapper>(client, salts, devices, spec).await?;
    let wrapper = unwrap_envelope(resp.envelope, "getUserFullInfo")?;
    wrapper.user_info.ok_or_else(|| ApiError::empty_data("user_info"))
}

/// 国服：用 SToken 换 game_role actionTicket（GET + DS Gen1 K2，对应 AuthClient）
pub async fn get_action_ticket(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
) -> ApiResult<String> {
    let stoken = user
        .stoken
        .get(crate::cookie::STOKEN)
        .ok_or_else(|| ApiError::retcode(-3, "缺少 stoken"))?;

    // stoken 需 percent 编码（对应 C# Uri.EscapeDataString）
    let encoded = encode_uri_component(stoken);
    let url = constants::url_action_ticket(&encoded, &user.aid);

    let mut spec = RequestSpec::get(url, Profile::Bbs)
        .with_cookie(user.stoken())
        .with_ds(DsSpec::Gen1 {
            salt: salts.cn_k2.clone(),
            include_chars: true,
        });
    if let Some(fp) = user.fingerprint.as_deref().filter(|f| !f.is_empty()) {
        spec = spec.with_device_fp(fp);
    }

    let resp = http::request::<ActionTicketData>(client, salts, devices, spec).await?;
    let data = unwrap_envelope(resp.envelope, "getActionTicketBySToken")?;
    Ok(data.ticket)
}

/// 获取游戏角色列表：国服走 actionTicket，国际服直接 LToken Cookie
pub async fn get_game_roles(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
) -> ApiResult<Vec<crate::models::GameRole>> {
    if user.is_oversea {
        let ltoken = user.ltoken.as_ref().ok_or_else(|| ApiError::retcode(-3, "缺少 LToken"))?;
        let spec = RequestSpec::get(constants::URL_GAME_ROLES_BY_COOKIE_OS, Profile::Bbs)
            .with_cookie(ltoken);
        let resp = http::request::<GameRoleList>(client, salts, devices, spec).await?;
        let data = unwrap_envelope(resp.envelope, "getUserGameRolesByCookie")?;
        Ok(data.list)
    } else {
        let ticket = get_action_ticket(client, salts, devices, user).await?;
        let ltoken = user.ltoken.as_ref().ok_or_else(|| ApiError::retcode(-3, "缺少 LToken"))?;
        let spec = RequestSpec::get(constants::url_game_roles_by_action_ticket(&ticket), Profile::Bbs)
            .with_cookie(ltoken);
        let resp = http::request::<GameRoleList>(client, salts, devices, spec).await?;
        let data = unwrap_envelope(resp.envelope, "getUserGameRoles")?;
        Ok(data.list)
    }
}

/// 对应 C# Uri.EscapeDataString：除字母数字与 `- _ . ~` 外全部编码
pub fn encode_uri_component(input: &str) -> String {
    const FRAGMENT: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
        .add(b' ')
        .add(b'!')
        .add(b'"')
        .add(b'#')
        .add(b'$')
        .add(b'%')
        .add(b'&')
        .add(b'\'')
        .add(b'(')
        .add(b')')
        .add(b'*')
        .add(b'+')
        .add(b',')
        .add(b'/')
        .add(b':')
        .add(b';')
        .add(b'<')
        .add(b'=')
        .add(b'>')
        .add(b'?')
        .add(b'@')
        .add(b'[')
        .add(b'\\')
        .add(b']')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}')
        .add(b'~');
    percent_encoding::utf8_percent_encode(input, FRAGMENT).to_string()
}
