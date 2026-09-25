//! 按祈愿活动期汇总历史记录，供祈愿页的活动期列表使用。

use crate::gacha::StoredItem;
use crate::gacha_events::{events, iso_to_local};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone, Default)]
pub struct EventItemCount {
    pub name: String,
    pub rank_type: i32,
    pub count: usize,
}

#[derive(Serialize, Clone, Default)]
pub struct EventHistory {
    pub name: String,
    pub version: String,
    pub from: String,
    pub to: String,
    pub query_type: i32,
    pub total_count: usize,
    pub items: Vec<EventItemCount>,
}

pub fn build_event_history(items: &[StoredItem]) -> Vec<EventHistory> {
    let windows: Vec<_> = events()
        .iter()
        .map(|event| (event, iso_to_local(&event.from), iso_to_local(&event.to)))
        .collect();
    let mut groups: HashMap<usize, Vec<&StoredItem>> = HashMap::new();
    let mut unmatched: HashMap<i32, Vec<&StoredItem>> = HashMap::new();

    for item in items {
        if let Some((index, _)) = windows.iter().enumerate().find(|(_, (event, from, to))| {
            event.gacha_type == item.gacha_type
                && from.as_str() <= item.time.as_str()
                && item.time.as_str() <= to.as_str()
        }) {
            groups.entry(index).or_default().push(item);
        } else {
            unmatched.entry(item.query_type).or_default().push(item);
        }
    }

    let mut result: Vec<EventHistory> = groups
        .into_iter()
        .map(|(index, entries)| {
            let (event, from, to) = &windows[index];
            EventHistory {
                name: event.name.clone(),
                version: event.version.clone(),
                from: from.clone(),
                to: to.clone(),
                query_type: event.gacha_type,
                total_count: entries.len(),
                items: count_items(&entries),
            }
        })
        .collect();
    for (query_type, entries) in unmatched {
        let from = entries
            .iter()
            .map(|item| item.time.as_str())
            .min()
            .unwrap_or("");
        let to = entries
            .iter()
            .map(|item| item.time.as_str())
            .max()
            .unwrap_or("");
        result.push(EventHistory {
            name: "未匹配活动期".into(),
            version: String::new(),
            from: from.into(),
            to: to.into(),
            query_type,
            total_count: entries.len(),
            items: count_items(&entries),
        });
    }
    result.sort_by(|a, b| b.from.cmp(&a.from).then(b.query_type.cmp(&a.query_type)));
    result
}

fn count_items(items: &[&StoredItem]) -> Vec<EventItemCount> {
    let mut counts: HashMap<(String, i32), usize> = HashMap::new();
    for item in items {
        *counts
            .entry((item.name.clone(), item.rank_type))
            .or_default() += 1;
    }
    let mut result: Vec<_> = counts
        .into_iter()
        .map(|((name, rank_type), count)| EventItemCount {
            name,
            rank_type,
            count,
        })
        .collect();
    result.sort_by(|a, b| {
        b.rank_type
            .cmp(&a.rank_type)
            .then(b.count.cmp(&a.count))
            .then(a.name.cmp(&b.name))
    });
    result
}
