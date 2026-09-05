//! 设备指纹（对应原版 UserFingerprintService + DeviceFpClient）：
//! 伪造一套安卓设备信息，向米哈游指纹接口换取 device_fp，7 天过期。

use crate::constants::{self, Salts};
use crate::http::{self, Devices, Profile, RequestSpec};
use crate::models::DeviceFpResult;
use crate::random;
use crate::response::{unwrap_envelope, ApiResult};
use serde_json::{json, Value};

pub async fn get_device_fp(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
) -> ApiResult<String> {
    let device = random::upper_alnum(12);
    let product = random::upper_alnum(6);

    // extendProperties 与原版 UserFingerprintService 的模板一致
    let ext_fields: Value = json!({
        "proxyStatus": 0,
        "isRoot": 0,
        "romCapacity": "512",
        "deviceName": device,
        "productName": product,
        "romRemain": "512",
        "hostname": "dg02-pool03-kvm87",
        "screenSize": "1440x2905",
        "isTablet": 0,
        "aaid": "",
        "model": device,
        "brand": "XiaoMi",
        "hardware": "qcom",
        "deviceType": "OP5913L1",
        "devId": "REL",
        "serialNumber": "unknown",
        "sdCapacity": 512215,
        "buildTime": "1693626947000",
        "buildUser": "android-build",
        "simState": 5,
        "ramRemain": "239814",
        "appUpdateTimeDiff": 1702604034482u64,
        "deviceInfo": format!("XiaoMi/{product}/OP5913L1:13/SKQ1.221119.001/T.118e6c7-5aa23-73911:user/release-keys"),
        "vaid": "",
        "buildType": "user",
        "sdkVersion": "34",
        "ui_mode": "UI_MODE_TYPE_NORMAL",
        "isMockLocation": 0,
        "cpuType": "arm64-v8a",
        "isAirMode": 0,
        "ringMode": 2,
        "chargeStatus": 1,
        "manufacturer": "XiaoMi",
        "emulatorStatus": 0,
        "appMemory": "512",
        "osVersion": "14",
        "vendor": "unknown",
        "accelerometer": "1.4883357x7.1712894x6.2847486",
        "sdRemain": 239600,
        "buildTags": "release-keys",
        "packageName": "com.mihoyo.hyperion",
        "networkType": "WiFi",
        "oaid": "",
        "debugStatus": 1,
        "ramCapacity": "469679",
        "magnetometer": "20.081251x-27.487501x2.1937501",
        "display": format!("{product}_13.1.0.181(CN01)"),
        "appInstallTimeDiff": 1688455751496u64,
        "packageVersion": "2.20.1",
        "gyroscope": "0.030226856x0.014647375x0.010652636",
        "batteryStatus": 100,
        "hasKeyboard": 0,
        "board": "taro",
    });

    let data = json!({
        "device_id": random::lower_hex(16),
        "seed_id": uuid::Uuid::new_v4().to_string(),
        "platform": "2",
        "seed_time": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default(),
        "ext_fields": ext_fields.to_string(),
        "app_name": "bbs_cn",
        "bbs_device_id": devices.id36,
        "device_fp": random::lower_hex(13),
    });

    let spec = RequestSpec::post(constants::URL_DEVICE_FP, Profile::Bbs, data);
    let resp = http::request::<DeviceFpResult>(client, salts, devices, spec).await?;
    let result = unwrap_envelope(resp.envelope, "getFp")?;
    Ok(result.device_fp)
}
