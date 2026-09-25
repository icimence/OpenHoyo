//! 祈愿卡池事件（对应原版 Model/Metadata/GachaEvent + Snap.Metadata 数据源）。
//!
//! 数据随二进制内嵌（src-tauri/src/data/），由 .github/workflows/update-banners.yml
//! 按周从上游镜像同步（gacha_events.json + item_names.json）。
//!
//! UP 判定口径与原版 GachaStatisticsFactory 一致，但匹配键为**名称**而非物品 Id：
//! CN 的 getGachaLog 接口不返回 item_id（恒为空），原版同样以名称反查元数据
//! （GachaLogServiceMetadataContext.GetItemId）。常驻(200)/新手(100)无 UP 概念；
//! 其余类型按物品时间落在 [From, To] 的卡池期，且名称 ∈ 该期 UP 五星名单则为中。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)] // Name/Version/Order 等字段为数据文件结构保留，运行时仅使用窗口与 UP 名单
pub struct GachaEvent {
    #[serde(rename = "Name")]
    pub name: String,
    #[serde(rename = "Version")]
    pub version: String,
    #[serde(rename = "Order")]
    pub order: u32,
    #[serde(rename = "From")]
    pub from: String,
    #[serde(rename = "To")]
    pub to: String,
    #[serde(rename = "Type")]
    pub gacha_type: i32,
    #[serde(rename = "UpOrangeList")]
    pub up_orange: Vec<u64>,
    #[serde(rename = "UpPurpleList", default)]
    pub up_purple: Vec<u64>,
}

static EVENTS: OnceLock<Vec<GachaEvent>> = OnceLock::new();
static ITEM_NAMES: OnceLock<HashMap<u64, String>> = OnceLock::new();

/// 预计算的匹配视图：(gacha_type, from_local, to_local, UP 名称集合)
struct UpWindow {
    gacha_type: i32,
    from: String,
    to: String,
    up_names: HashSet<String>,
}

static UP_WINDOWS: OnceLock<Vec<UpWindow>> = OnceLock::new();
/// 计时页展示最近两年的 UP，避免年代久远的活动淹没当前轮换。
const COUNTDOWN_MAX_DAYS: i64 = 730;

pub fn events() -> &'static [GachaEvent] {
    EVENTS.get_or_init(|| {
        serde_json::from_str(include_str!("data/gacha_events.json")).unwrap_or_default()
    })
}

fn item_names() -> &'static HashMap<u64, String> {
    ITEM_NAMES.get_or_init(|| {
        serde_json::from_str(include_str!("data/item_names.json")).unwrap_or_default()
    })
}

fn up_windows() -> &'static [UpWindow] {
    UP_WINDOWS.get_or_init(|| {
        let names = item_names();
        events()
            .iter()
            .map(|e| UpWindow {
                gacha_type: e.gacha_type,
                from: iso_to_local(&e.from),
                to: iso_to_local(&e.to),
                up_names: e
                    .up_orange
                    .iter()
                    .filter_map(|id| names.get(id).cloned())
                    .collect(),
            })
            .collect()
    })
}

/// "2026-08-12T06:00:00+08:00" → "2026-08-12 06:00:00"
/// （卡池数据为 +08:00 国服时区，祈愿记录 time 亦为国服本地时间，字符串可直接比较）
pub(crate) fn iso_to_local(iso: &str) -> String {
    iso.replace('T', " ")
        .split('+')
        .next()
        .unwrap_or("")
        .to_string()
}

/// 该物品在此时间是否命中当期 UP（按名称匹配；400 与 301 为并行双池，各有独立 UP 名单）
pub fn is_up(gacha_type: i32, name: &str, time: &str) -> bool {
    if gacha_type == 200 || gacha_type == 100 {
        return false;
    }
    up_windows().iter().any(|w| {
        w.gacha_type == gacha_type
            && w.up_names.contains(name)
            && w.from.as_str() <= time
            && time <= w.to.as_str()
    })
}

#[derive(Serialize)]
pub struct GachaCountdown {
    pub name: String,
    pub rank_type: i32,
    pub item_type: &'static str,
    pub days: i64,
    pub last_up: String,
    pub version: String,
}

/// 本地元数据里的最近一期 UP，用国服时区计算已过天数。
#[tauri::command]
pub fn gacha_countdown() -> Vec<GachaCountdown> {
    let today = (chrono::Utc::now() + chrono::Duration::hours(8)).date_naive();
    let today_text = today.format("%Y-%m-%d").to_string();
    let mut latest: HashMap<u64, (&GachaEvent, i32, &'static str)> = HashMap::new();
    for event in events() {
        if !matches!(event.gacha_type, 301 | 400 | 302 | 500)
            || event.from.get(..10).unwrap_or("") > today_text.as_str()
        {
            continue;
        }
        for id in &event.up_orange {
            let replace = latest
                .get(id)
                .is_none_or(|(old, _, _)| old.from < event.from);
            let kind = if *id >= 10_000_000 {
                "角色"
            } else {
                "武器"
            };
            if replace {
                latest.insert(*id, (event, 5, kind));
            }
        }
        for id in &event.up_purple {
            let replace = latest
                .get(id)
                .is_none_or(|(old, _, _)| old.from < event.from);
            let kind = if *id >= 10_000_000 {
                "角色"
            } else {
                "武器"
            };
            if replace {
                latest.insert(*id, (event, 4, kind));
            }
        }
    }
    let names = item_names();
    let mut result: Vec<_> = latest
        .into_iter()
        .filter_map(|(id, (event, rank_type, item_type))| {
            let name = names.get(&id)?.clone();
            let date = chrono::NaiveDate::parse_from_str(event.to.get(..10)?, "%Y-%m-%d").ok()?;
            let days = (today - date).num_days().max(0);
            if days > COUNTDOWN_MAX_DAYS {
                return None;
            }
            Some(GachaCountdown {
                name,
                rank_type,
                item_type,
                days,
                last_up: date.format("%Y.%m.%d").to_string(),
                version: format!(
                    "{} {}半",
                    event.version,
                    if event.from.contains("18:00") {
                        "下"
                    } else {
                        "上"
                    }
                ),
            })
        })
        .collect();
    result.sort_by(|a, b| b.days.cmp(&a.days).then(a.name.cmp(&b.name)));
    log::info!("[gacha] 计时数据就绪，共 {} 项", result.len());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_loaded_and_sane() {
        let evs = events();
        assert!(evs.len() > 200, "卡池数据量异常: {}", evs.len());
        assert!(evs.iter().any(|e| e.gacha_type == 301));
        assert!(evs.iter().any(|e| e.gacha_type == 302));
        assert!(
            item_names().len() > 300,
            "名称映射异常: {}",
            item_names().len()
        );
        // 预计算后不应存在空 UP 名单的活动池（除非映射缺失）
        let empty = up_windows()
            .iter()
            .filter(|w| w.gacha_type != 500 && w.up_names.is_empty())
            .count();
        assert_eq!(empty, 0, "存在 UP 名单解析失败的卡池");
    }

    #[test]
    fn up_determination() {
        // 用第一期角色活动池（迪卢克/刻晴时代）验证
        let ev = events()
            .iter()
            .find(|e| e.gacha_type == 301 && !e.up_orange.is_empty())
            .expect("无角色活动池");
        let up_name = item_names()
            .get(&ev.up_orange[0])
            .expect("UP 物品无名称映射")
            .clone();

        // 卡池开始后 1 小时（保证落在窗口内）
        let from_local = iso_to_local(&ev.from);
        let hour: u32 = from_local[11..13].parse().unwrap();
        let t = format!("{}{:02}:00:00", &from_local[..11], hour + 1);

        assert!(
            is_up(301, &up_name, &t),
            "UP 物品 [{}] 在活动期内应判定为中",
            up_name
        );
        assert!(!is_up(200, &up_name, &t), "常驻池恒为非 UP");
        assert!(!is_up(301, "不存在的角色", &t), "非 UP 物品应判定为歪");
    }
}
