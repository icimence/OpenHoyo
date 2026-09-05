//! DS（Dynamic Secret）请求签名，算法与原版 DataSignAlgorithm/DataSignOptions 一致：
//!
//! Gen2: `t,r,md5("salt={salt}&t={t}&r={r}&b={body}&q={query}")`
//! Gen1: `t,r,md5("salt={salt}&t={t}&r={r}")`
//!
//! 其中 t 为秒级时间戳，r 见 `crate::random::ds_random`；
//! body 为空时 PROD salt 默认 `{}`，其它默认空串；
//! query 按 C# 逻辑先整体 percent 解码、再按 `&` 分段排序后拼接。

use crate::random;
use md5::{Digest, Md5};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn md5_hex(input: &str) -> String {
    let digest = Md5::digest(input.as_bytes());
    let mut out = String::with_capacity(32);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub enum DsBody<'a> {
    /// 请求体字符串
    Raw(&'a str),
    /// 无请求体：PROD salt 用 "{}"，其它用 ""
    None { is_prod: bool },
}

pub fn ds_gen1(salt: &str, include_chars: bool) -> String {
    let t = unix_secs();
    let r = random::ds_random(include_chars);
    let check = md5_hex(&format!("salt={salt}&t={t}&r={r}"));
    format!("{t},{r},{check}")
}

pub fn ds_gen2(salt: &str, include_chars: bool, body: DsBody<'_>, query: &str) -> String {
    let t = unix_secs();
    let r = random::ds_random(include_chars);
    let b = match body {
        DsBody::Raw(s) => s.to_string(),
        DsBody::None { is_prod } => {
            if is_prod {
                "{}".to_string()
            } else {
                String::new()
            }
        }
    };
    let q = sort_query(query);
    let check = md5_hex(&format!("salt={salt}&t={t}&r={r}&b={b}&q={q}"));
    format!("{t},{r},{check}")
}

/// 对应 C#：Uri.UnescapeDataString(query).Split('?',2)[1].Split('&').OrderBy(x => x).Join("&")
/// 传入的 query 不含 '?'，为空则返回空串。
pub fn sort_query(query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    let decoded = percent_encoding::percent_decode_str(query)
        .decode_utf8_lossy()
        .to_string();
    let mut parts: Vec<&str> = decoded.split('&').collect();
    parts.sort_unstable();
    parts.join("&")
}

/// 从完整 URL 提取不含 '?' 的 query 部分
pub fn query_of(url: &str) -> &str {
    match url.split_once('?') {
        Some((_, q)) => q,
        None => "",
    }
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_query_orders_segments() {
        assert_eq!(sort_query("b=2&a=1"), "a=1&b=2");
        assert_eq!(sort_query("uid=1&action_type=game_role"), "action_type=game_role&uid=1");
        assert_eq!(sort_query(""), "");
    }

    #[test]
    fn ds_format() {
        let ds = ds_gen1("salt", true);
        assert_eq!(ds.split(',').count(), 3);
    }

    #[test]
    fn md5_known_value() {
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }
}
