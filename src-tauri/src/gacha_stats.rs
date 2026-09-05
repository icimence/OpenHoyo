//! 祈愿统计构建（对应原版 TypedWishSummaryBuilder + GachaStatisticsFactory）。
//!
//! 池子归类（TypeEvaluator）：
//! - 角色活动祈愿：gacha_type 301 | 400（400 归并查询到 301）
//! - 武器活动祈愿：302
//! - 常驻祈愿：200
//! - 集录祈愿：500
//! 新手祈愿(100)不计入统计卡。
//!
//! 统计算法与原版逐行对应：按 id 升序遍历，橙色(5星)记录抽数区间并重置计数器，
//! 紫色(4星)重置紫计数，累计时间范围与三档品质数量。

use crate::gacha::{guarantee_thresholds, StoredItem};
use serde::Serialize;

#[derive(Serialize, Clone, Default)]
pub struct OrangeEntry {
    pub name: String,
    pub item_type: String,
    pub pull: i32,
    pub time: String,
    /// 是否当期 UP（大保底中的为 true，歪的为 false）
    pub is_up: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct WishSummary {
    pub name: String,
    pub total_count: i32,
    pub from_time: String,
    pub to_time: String,

    pub total_orange: i32,
    pub total_purple: i32,
    pub total_blue: i32,
    pub orange_percent: f64,
    pub purple_percent: f64,
    pub blue_percent: f64,

    pub last_orange_pull: i32,
    pub last_purple_pull: i32,
    pub guarantee_orange_threshold: i32,
    pub guarantee_purple_threshold: i32,

    pub max_orange_pull: i32,
    pub min_orange_pull: i32,
    pub average_orange_pull: f64,

    /// UP 命中数（中）与歪的次数（仅角色/武器池有意义）
    pub total_up_orange: i32,
    pub total_lost_orange: i32,
    /// UP 五星平均出货抽数（对应原版 AverageUpOrangePull）
    pub average_up_orange_pull: f64,
    /// 当前是否处于大保底（最近一个五星是歪的）
    pub guaranteed: bool,
    /// 该池是否有 UP 概念（角色/武器活动池 true，常驻/集录 false）
    pub has_up: bool,

    pub orange_list: Vec<OrangeEntry>,
}

#[derive(Serialize, Clone, Default)]
pub struct HistoryGroup {
    /// 组内条目（从旧到新）
    pub items: Vec<StoredItem>,
    /// 组内抽数（不含五星则为当前累计）
    pub count: i32,
}

#[derive(Serialize, Clone, Default)]
pub struct NameCountEntry {
    pub name: String,
    pub item_type: String,
    pub rank_type: i32,
    pub count: i32,
}

#[derive(Serialize, Clone, Default)]
pub struct PoolHistory {
    pub query_type: i32,
    pub name: String,
    pub groups: Vec<HistoryGroup>,
}

#[derive(Serialize, Clone, Default)]
pub struct GachaStatisticsDto {
    pub uid: String,
    pub total_count: i32,
    pub avatar_wish: WishSummary,
    pub weapon_wish: WishSummary,
    pub standard_wish: WishSummary,
    pub chronicled_wish: WishSummary,
    pub history: Vec<PoolHistory>,
    pub avatars: Vec<NameCountEntry>,
    pub weapons: Vec<NameCountEntry>,
}

fn pool_name(query_type: i32) -> &'static str {
    match query_type {
        100 => "新手祈愿",
        200 => "常驻祈愿",
        301 => "角色活动祈愿",
        302 => "武器活动祈愿",
        400 => "角色活动祈愿-2",
        500 => "集录祈愿",
        _ => "未知",
    }
}

fn matches_pool(query_type: i32, pool: i32) -> bool {
    match pool {
        301 => query_type == 301, // 400 已在入库时归并到 301
        302 => query_type == 302,
        200 => query_type == 200,
        500 => query_type == 500,
        _ => false,
    }
}

/// TypedWishSummaryBuilder 的一比一移植（含 UP/歪与大保底推导）
fn build_wish_summary(name: &str, pool: i32, items: &[&StoredItem]) -> WishSummary {
    let (orange_threshold, purple_threshold) = guarantee_thresholds(pool);
    let mut summary = WishSummary {
        name: name.to_string(),
        guarantee_orange_threshold: orange_threshold,
        guarantee_purple_threshold: purple_threshold,
        // UP 概念仅存在于角色活动(301/400)/武器活动(302)池
        has_up: matches!(pool, 301 | 302),
        ..Default::default()
    };

    let mut orange_pulls: Vec<i32> = Vec::new();
    let mut up_orange_pulls: Vec<i32> = Vec::new();
    // 距上个 UP 五星的抽数（对应原版 lastUpOrangePull，仅 UP 五星时清零）
    let mut last_up_pull: i32 = 0;

    for item in items {
        summary.total_count += 1;
        summary.last_orange_pull += 1;
        summary.last_purple_pull += 1;
        last_up_pull += 1;

        if summary.from_time.is_empty() || item.time < summary.from_time {
            summary.from_time = item.time.clone();
        }
        if item.time > summary.to_time {
            summary.to_time = item.time.clone();
        }

        match item.rank_type {
            5 => {
                let pull = summary.last_orange_pull;
                if summary.min_orange_pull == 0 || pull < summary.min_orange_pull {
                    summary.min_orange_pull = pull;
                }
                if pull > summary.max_orange_pull {
                    summary.max_orange_pull = pull;
                }
                orange_pulls.push(pull);

                let is_up = item.is_up;
                if is_up {
                    summary.total_up_orange += 1;
                    up_orange_pulls.push(last_up_pull);
                    last_up_pull = 0;
                } else if summary.has_up {
                    summary.total_lost_orange += 1;
                }

                summary.orange_list.push(OrangeEntry {
                    name: item.name.clone(),
                    item_type: item.item_type.clone(),
                    pull,
                    time: item.time.clone(),
                    is_up,
                });
                summary.last_orange_pull = 0;
                summary.total_orange += 1;
            }
            4 => {
                summary.last_purple_pull = 0;
                summary.total_purple += 1;
            }
            _ => {
                summary.total_blue += 1;
            }
        }
    }

    // 大保底：最近一个五星是歪的 → 下一个五星必中 UP
    if summary.has_up {
        summary.guaranteed = summary.orange_list.last().is_some_and(|e| !e.is_up);
    }

    let total = summary.total_count as f64;
    if total > 0.0 {
        summary.orange_percent = summary.total_orange as f64 / total;
        summary.purple_percent = summary.total_purple as f64 / total;
        summary.blue_percent = summary.total_blue as f64 / total;
    }
    if !orange_pulls.is_empty() {
        summary.average_orange_pull = orange_pulls.iter().sum::<i32>() as f64 / orange_pulls.len() as f64;
    }
    if !up_orange_pulls.is_empty() {
        summary.average_up_orange_pull =
            up_orange_pulls.iter().sum::<i32>() as f64 / up_orange_pulls.len() as f64;
    }
    summary
}

pub fn build_statistics(uid: &str, items: &[StoredItem]) -> GachaStatisticsDto {
    let mut dto = GachaStatisticsDto {
        uid: uid.to_string(),
        ..Default::default()
    };
    dto.total_count = items.len() as i32;

    // 为每条五星记录判定 UP（历史分组等处使用；按名称匹配，CN 接口无 item_id）
    let mut owned: Vec<StoredItem> = items.to_vec();
    for item in owned.iter_mut() {
        if item.rank_type == 5 {
            item.is_up = crate::gacha_events::is_up(item.gacha_type, &item.name, &item.time);
        }
    }

    // 各池统计（按 id 升序 = 从旧到新）
    let avatar: Vec<&StoredItem> = owned.iter().filter(|i| matches_pool(i.query_type, 301)).collect();
    let weapon: Vec<&StoredItem> = owned.iter().filter(|i| matches_pool(i.query_type, 302)).collect();
    let standard: Vec<&StoredItem> = owned.iter().filter(|i| matches_pool(i.query_type, 200)).collect();
    let chronicled: Vec<&StoredItem> = owned.iter().filter(|i| matches_pool(i.query_type, 500)).collect();

    dto.avatar_wish = build_wish_summary("角色活动祈愿", 301, &avatar);
    dto.weapon_wish = build_wish_summary("武器活动祈愿", 302, &weapon);
    dto.standard_wish = build_wish_summary("常驻祈愿", 200, &standard);
    dto.chronicled_wish = build_wish_summary("集录祈愿", 500, &chronicled);

    // 历史分组：每种池子，按五星切组（最新组在前）；顺序 角色→武器→常驻→集录→新手
    for &query_type in &[301i32, 302, 200, 500, 100] {
        let pool_items: Vec<&StoredItem> = owned.iter().filter(|i| i.query_type == query_type).collect();
        if pool_items.is_empty() {
            continue;
        }
        let mut groups: Vec<HistoryGroup> = Vec::new();
        let mut current: Vec<StoredItem> = Vec::new();
        // 从旧到新累计，遇五星封组
        for item in pool_items {
            current.push(item.clone());
            if item.rank_type == 5 {
                let count = current.len() as i32;
                groups.push(HistoryGroup { items: std::mem::take(&mut current), count });
            }
        }
        if !current.is_empty() {
            let count = current.len() as i32;
            groups.push(HistoryGroup { items: current, count });
        }
        groups.reverse(); // 最新组在前
        dto.history.push(PoolHistory {
            query_type,
            name: pool_name(query_type).to_string(),
            groups,
        });
    }

    // 角色 / 武器 出货列表（按数量降序）
    let mut avatar_map: std::collections::HashMap<(String, i32), NameCountEntry> = Default::default();
    let mut weapon_map: std::collections::HashMap<(String, i32), NameCountEntry> = Default::default();
    for item in &owned {
        let entry = if item.item_type == "角色" {
            avatar_map.entry((item.name.clone(), item.rank_type)).or_insert_with(|| NameCountEntry {
                name: item.name.clone(),
                item_type: item.item_type.clone(),
                rank_type: item.rank_type,
                count: 0,
            })
        } else {
            weapon_map.entry((item.name.clone(), item.rank_type)).or_insert_with(|| NameCountEntry {
                name: item.name.clone(),
                item_type: item.item_type.clone(),
                rank_type: item.rank_type,
                count: 0,
            })
        };
        entry.count += 1;
    }
    let mut avatars: Vec<NameCountEntry> = avatar_map.into_values().collect();
    let mut weapons: Vec<NameCountEntry> = weapon_map.into_values().collect();
    avatars.sort_by(|a, b| b.rank_type.cmp(&a.rank_type).then(b.count.cmp(&a.count)).then(a.name.cmp(&b.name)));
    weapons.sort_by(|a, b| b.rank_type.cmp(&a.rank_type).then(b.count.cmp(&a.count)).then(a.name.cmp(&b.name)));
    dto.avatars = avatars;
    dto.weapons = weapons;

    dto
}
