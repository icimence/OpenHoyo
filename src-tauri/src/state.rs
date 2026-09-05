//! 应用状态：HTTP 客户端、设备标识、salt（运行时可刷新）、SQLite 连接。

use crate::constants::Salts;
use crate::http::Devices;
use std::sync::Mutex;
use tokio::sync::RwLock;

pub struct AppState {
    pub http: reqwest::Client,
    pub devices: Devices,
    pub salts: RwLock<Salts>,
    /// 短临界区使用 std Mutex；严禁跨 .await 持锁
    pub db: Mutex<rusqlite::Connection>,
}

impl AppState {
    pub fn new(db: rusqlite::Connection) -> Self {
        Self {
            http: reqwest::Client::new(),
            devices: Devices::new(),
            salts: RwLock::new(Salts::default()),
            db: Mutex::new(db),
        }
    }
}

/// 在异步上下文获取 salt 快照
pub async fn salts(state: &AppState) -> Salts {
    state.salts.read().await.clone()
}
