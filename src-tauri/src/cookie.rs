//! Cookie 容器：排序键值对，序列化为 `k1=v1;k2=v2`（与原版 Cookie.cs 行为一致，
//! BTreeMap 对应原版 SortedDictionary，保证 Cookie 头的键序稳定）。

use std::collections::BTreeMap;
use std::fmt;

pub const STUID: &str = "stuid";
pub const MID: &str = "mid";
pub const STOKEN: &str = "stoken";
pub const LTUID: &str = "ltuid";
pub const LTOKEN: &str = "ltoken";
pub const ACCOUNT_ID: &str = "account_id";
pub const COOKIE_TOKEN: &str = "cookie_token";
/// 完整 Cookie 字符串中的设备指纹键（导入时用于提取 device_fp）
#[allow(dead_code)]
pub const DEVICEFP: &str = "DEVICEFP";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cookie(pub BTreeMap<String, String>);

impl Cookie {
    pub fn new() -> Self {
        Self(BTreeMap::new())
    }

    /// 解析形如 `k1=v1; k2=v2` 的 cookie 字符串（首个出现的键优先）
    pub fn parse(raw: &str) -> Self {
        let mut map = BTreeMap::new();
        for pair in raw.replace(' ', "").split(';') {
            if pair.is_empty() {
                continue;
            }
            let mut parts = pair.splitn(2, '=');
            let name = parts.next().unwrap_or("").trim();
            let value = parts.next().map(|v| v.trim()).unwrap_or("");
            if !name.is_empty() {
                map.entry(name.to_string()).or_insert_with(|| value.to_string());
            }
        }
        Self(map)
    }

    pub fn insert(&mut self, key: &str, value: impl Into<String>) {
        self.0.insert(key.to_string(), value.into());
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        self.0.get(key)
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// 提取一组键构造子 Cookie；任一键缺失则返回 None（对应原版 TryGetValuesToCookie）
    pub fn subset(&self, keys: &[&str]) -> Option<Cookie> {
        let mut sub = BTreeMap::new();
        for key in keys {
            let v = self.0.get(*key)?;
            sub.insert((*key).to_string(), v.clone());
        }
        Some(Cookie(sub))
    }

    /// SToken 子凭证（mid + stoken + stuid）
    pub fn stoken(&self) -> Option<Cookie> {
        self.subset(&[MID, STOKEN, STUID])
    }

    /// LToken 子凭证（ltoken + ltuid）
    #[allow(dead_code)]
    pub fn ltoken(&self) -> Option<Cookie> {
        self.subset(&[LTOKEN, LTUID])
    }

    /// CookieToken 子凭证（account_id + cookie_token）
    #[allow(dead_code)]
    pub fn cookie_token(&self) -> Option<Cookie> {
        self.subset(&[ACCOUNT_ID, COOKIE_TOKEN])
    }

    #[allow(dead_code)]
    pub fn device_fp(&self) -> Option<&String> {
        self.0.get(DEVICEFP)
    }
}

impl fmt::Display for Cookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let joined: Vec<String> = self.0.iter().map(|(k, v)| format!("{k}={v}")).collect();
        write!(f, "{}", joined.join(";"))
    }
}

/// 构造 SToken 凭证（登录成功后由 aid/mid/stoken 组装）
pub fn build_stoken_cookie(stuid: &str, mid: &str, stoken: &str) -> Cookie {
    let mut c = Cookie::new();
    c.insert(STUID, stuid);
    c.insert(MID, mid);
    c.insert(STOKEN, stoken);
    c
}

/// 构造 LToken 凭证
pub fn build_ltoken_cookie(ltuid: &str, ltoken: &str) -> Cookie {
    let mut c = Cookie::new();
    c.insert(LTUID, ltuid);
    c.insert(LTOKEN, ltoken);
    c
}

/// 构造 CookieToken 凭证
pub fn build_cookie_token_cookie(account_id: &str, cookie_token: &str) -> Cookie {
    let mut c = Cookie::new();
    c.insert(ACCOUNT_ID, account_id);
    c.insert(COOKIE_TOKEN, cookie_token);
    c
}
