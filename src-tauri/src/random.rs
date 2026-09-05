//! 随机字符串工具，字符集与原版 Core.Random 完全一致。

use rand::Rng;

const DIGITS_LOWER: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const DIGITS_LOWER_HEX: &[u8] = b"0123456789abcdef";
const DIGITS_UPPER: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

pub fn lower_alnum(len: usize) -> String {
    sample_from(DIGITS_LOWER, len)
}

pub fn lower_hex(len: usize) -> String {
    sample_from(DIGITS_LOWER_HEX, len)
}

pub fn upper_alnum(len: usize) -> String {
    sample_from(DIGITS_UPPER, len)
}

fn sample_from(charset: &[u8], len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| charset[rng.gen_range(0..charset.len())] as char)
        .collect()
}

/// DS 随机串：include_chars 时为 6 位小写字母数字，否则为 100000-199999 的数字
/// （100000 特殊映射为 642367，与原版 DataSignOptions.GetRandomNumberString 一致）
pub fn ds_random(include_chars: bool) -> String {
    if include_chars {
        return lower_alnum(6);
    }
    let mut rng = rand::thread_rng();
    let n = rng.gen_range(100_000..200_000);
    if n == 100_000 {
        "642367".to_string()
    } else {
        n.to_string()
    }
}
