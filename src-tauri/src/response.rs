//! 米哈游接口统一响应封装与错误类型。

use serde::{Deserialize, Serialize};

/// `{ retcode, message, data }` 响应信封
#[derive(Debug, Deserialize)]
pub struct Envelope<T> {
    #[serde(default)]
    pub retcode: i32,
    #[serde(default)]
    pub message: String,
    // 泛型字段用显式默认值，避免 serde 要求 T: Default
    #[serde(default = "none_default")]
    pub data: Option<T>,
}

fn none_default<T>() -> Option<T> {
    None
}

impl<T> Envelope<T> {
    #[allow(dead_code)]
    pub fn ok(&self) -> bool {
        self.retcode == 0
    }
}

/// 传递给前端的错误结构（与前端 ApiErrorShape 对应）
#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub code: i32,
    pub message: String,
}

impl ApiError {
    pub fn retcode(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self { code: -1, message: format!("网络请求失败: {}", message.into()) }
    }

    /// retcode 为 0 但 data 缺失等情况
    pub fn empty_data(context: &str) -> Self {
        Self { code: -2, message: format!("响应缺少数据: {context}") }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

/// 校验信封并取出 data
pub fn unwrap_envelope<T>(env: Envelope<T>, context: &str) -> ApiResult<T> {
    if env.retcode != 0 {
        // 常见登录失效码附加上下文提示（对应原版 KnownReturnCode 处理）
        let hint = match env.retcode {
            -100 | 10001 => "（登录态失效，请删除用户后重新登录）",
            _ => "",
        };
        return Err(ApiError::retcode(env.retcode, format!("{}{hint}", env.message)));
    }
    env.data.ok_or_else(|| ApiError::empty_data(context))
}
