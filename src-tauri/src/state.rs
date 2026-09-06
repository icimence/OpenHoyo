//! 应用状态：HTTP 客户端、设备标识、salt（运行时可刷新）、SQLite 连接。

use crate::constants::Salts;
use crate::http::Devices;
use crate::store;
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
        // device_id 跨启动持久化：设备指纹绑定它，随机重生等于每次启动"换设备"，容易触发风控
        let existing = store::meta_get(&db, "device_id36");
        let devices = match existing {
            Some(id) if !id.is_empty() => Devices::with_id36(id),
            _ => {
                let devices = Devices::new();
                store::meta_set(&db, "device_id36", &devices.id36);
                devices
            }
        };
        Self {
            http: reqwest::Client::new(),
            devices,
            salts: RwLock::new(Salts::default()),
            db: Mutex::new(db),
        }
    }
}

/// 在异步上下文获取 salt 快照
pub async fn salts(state: &AppState) -> Salts {
    state.salts.read().await.clone()
}
