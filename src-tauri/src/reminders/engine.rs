//! 提醒计划的纯计算部分。系统通知只消费计划，不在前端计时。
use crate::daily_note::DailyNoteData;
use serde::{Deserialize, Serialize};

pub const MAX_NODES: usize = 12;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Threshold {
    pub value: i32,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceRule {
    pub enabled: bool,
    pub thresholds: Vec<Threshold>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub resin: ResourceRule,
    pub home_coin: ResourceRule,
    pub expeditions: bool,
}
impl Default for Settings {
    fn default() -> Self {
        let rule = |values: &[i32]| ResourceRule {
            enabled: false,
            thresholds: values
                .iter()
                .map(|&value| Threshold {
                    value,
                    enabled: true,
                })
                .collect(),
        };
        Self {
            resin: rule(&[160, 180, 200]),
            home_coin: rule(&[1800, 2000, 2400]),
            expeditions: false,
        }
    }
}
impl Settings {
    /// 初始预设随角色实际容量调整（低信任等阶的洞天容量可能不足 2400）。
    pub fn adapt_defaults(&mut self, note: Option<&DailyNoteData>) {
        let Some(note) = note else {
            return;
        };
        for (rule, defaults, max, numerators, denominator) in [
            (
                &mut self.resin,
                vec![160, 180, 200],
                note.max_resin,
                [8, 9, 10],
                10,
            ),
            (
                &mut self.home_coin,
                vec![1800, 2000, 2400],
                note.max_home_coin,
                [9, 10, 12],
                12,
            ),
        ] {
            if max > 0
                && max < *defaults.last().unwrap()
                && rule.thresholds.iter().map(|t| t.value).eq(defaults)
            {
                for (node, numerator) in rule.thresholds.iter_mut().zip(numerators) {
                    node.value = (max * numerator / denominator).max(1);
                }
                rule.thresholds.dedup_by_key(|t| t.value);
            }
        }
    }
    pub fn active(&self) -> bool {
        self.expeditions
            || [&self.resin, &self.home_coin]
                .iter()
                .any(|r| r.enabled && r.thresholds.iter().any(|t| t.enabled))
    }
    pub fn validate(&mut self, note: Option<&DailyNoteData>) -> Result<(), String> {
        self.adapt_defaults(note);
        for (name, rule, max) in [
            (
                "树脂",
                &mut self.resin,
                note.map(|n| n.max_resin).filter(|&n| n > 0).unwrap_or(200),
            ),
            (
                "洞天宝钱",
                &mut self.home_coin,
                note.map(|n| n.max_home_coin)
                    .filter(|&n| n > 0)
                    .unwrap_or(2400),
            ),
        ] {
            if rule.thresholds.len() > MAX_NODES {
                return Err(format!("{name}最多设置 {MAX_NODES} 个提醒节点"));
            }
            // 暂停的类别可保留未来容量的自定义节点，不阻碍另一类设置的保存。
            let max = if rule.enabled {
                max
            } else {
                max.max(if name == "树脂" { 200 } else { 2400 })
            };
            rule.thresholds.sort_by_key(|t| t.value);
            if rule.thresholds.iter().any(|t| t.value < 1 || t.value > max) {
                return Err(format!("{name}提醒数值应在 1～{max} 之间"));
            }
            if rule.thresholds.windows(2).any(|w| w[0].value == w[1].value) {
                return Err(format!("{name}提醒数值不能重复"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Job {
    pub id: i32,
    pub kind: String,
    pub value: i32,
    pub due_at_ms: i64,
    /// 本轮预计全部恢复时间。消耗资源/重新派遣会把它显著推后，允许同一节点再次提醒。
    pub anchor_at_ms: i64,
    pub delivered: bool,
    pub scheduled: bool,
}
impl Job {
    pub fn text(&self, name: &str) -> (String, String) {
        match self.kind.as_str() {
            "resin" => (
                format!("树脂预计已恢复至 {}", self.value),
                format!("{name} · 记得上线消耗树脂，避免恢复溢出。"),
            ),
            "home_coin" => (
                format!("洞天宝钱预计已积累至 {}", self.value),
                format!("{name} · 可以回尘歌壶领取宝钱了。"),
            ),
            _ => (
                "探索派遣预计已全部完成".into(),
                format!("{name} · 可以领取奖励并重新派遣了。"),
            ),
        }
    }
}

/// 根据接口的回满倒计时插值；树脂用已知的每点 8 分钟，保留下一点恢复的零头。
fn resource_due(current: i32, max: i32, remaining: i64, value: i32, resin: bool) -> Option<i64> {
    if max <= 0 || current >= value || value > max || current < 0 || remaining <= 0 {
        return None;
    }
    let resin_seconds = remaining.saturating_sub(i64::from(max - value) * 480);
    let seconds = if resin && resin_seconds > 0 {
        resin_seconds
    } else {
        // 宝钱产速随洞天仙力变化，接口未提供产速，按本次回满时间估算。
        (remaining as f64 * f64::from(value - current) / f64::from(max - current)).ceil() as i64
    };
    Some(seconds.max(1))
}

/// 每个节点在同一恢复轮次只提醒一次。已达到的节点在首次开启时不会补发。
pub fn plan(settings: &Settings, note: &DailyNoteData, old: &[Job], now: i64) -> Vec<Job> {
    let mut desired = Vec::new();
    let mut push = |kind: &str, value: i32, due: Option<i64>, anchor: i64| {
        let previous = old.iter().find(|j| j.kind == kind && j.value == value);
        let Some(due_at_ms) = due else {
            if let Some(job) = previous {
                let mut job = job.clone();
                // 新快照已达到节点（例如使用脆弱树脂），提前交付原有提醒。
                if !job.delivered && job.due_at_ms > note.fetched_at_ms {
                    job.due_at_ms = note.fetched_at_ms;
                    job.scheduled = false;
                }
                desired.push(job);
            }
            return;
        };
        if due_at_ms <= now && previous.is_none() {
            return;
        }
        let mut job = previous.cloned().unwrap_or(Job {
            id: 0,
            kind: kind.into(),
            value,
            due_at_ms,
            anchor_at_ms: anchor,
            delivered: false,
            scheduled: false,
        });
        // 分钟级的接口倒计时误差不会被当成新一轮，防止刷新时重复通知。
        let new_cycle = anchor > job.anchor_at_ms.saturating_add(120_000);
        if job.delivered && !new_cycle {
            desired.push(job);
            return;
        }
        if new_cycle {
            job.delivered = false;
        }
        if job.due_at_ms != due_at_ms || new_cycle {
            job.scheduled = false;
        }
        job.due_at_ms = due_at_ms;
        job.anchor_at_ms = anchor;
        desired.push(job);
    };
    for (kind, rule, current, max, remaining, resin) in [
        (
            "resin",
            &settings.resin,
            note.current_resin,
            note.max_resin,
            note.resin_recovery_time,
            true,
        ),
        (
            "home_coin",
            &settings.home_coin,
            note.current_home_coin,
            note.max_home_coin,
            note.home_coin_recovery_time,
            false,
        ),
    ] {
        if !rule.enabled || max <= 0 {
            continue;
        }
        let anchor = note
            .fetched_at_ms
            .saturating_add(remaining.saturating_mul(1000));
        for t in rule
            .thresholds
            .iter()
            .filter(|t| t.enabled && t.value <= max)
        {
            if current < t.value && (remaining <= 0 || current < 0) {
                continue;
            }
            let due = resource_due(current, max, remaining, t.value, resin)
                .map(|s| note.fetched_at_ms.saturating_add(s.saturating_mul(1000)));
            push(kind, t.value, due, anchor);
        }
    }
    if settings.expeditions && !note.expeditions.is_empty() {
        let remaining = note
            .expeditions
            .iter()
            .filter(|e| e.status != "Finished")
            .map(|e| e.remained_time.max(0))
            .max()
            .unwrap_or(0);
        let anchor = note
            .fetched_at_ms
            .saturating_add(remaining.saturating_mul(1000));
        push("expeditions", 0, (remaining > 0).then_some(anchor), anchor);
    }
    desired
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_800_000_000_000;
    fn note() -> DailyNoteData {
        DailyNoteData {
            fetched_at_ms: NOW,
            current_resin: 80,
            max_resin: 200,
            resin_recovery_time: 120 * 480 - 120,
            current_home_coin: 1000,
            max_home_coin: 2400,
            home_coin_recovery_time: 1400 * 120,
            ..Default::default()
        }
    }
    #[test]
    fn multiple_thresholds_preserve_partial_resin_tick() {
        let mut s = Settings::default();
        s.resin.enabled = true;
        s.resin.thresholds.insert(
            0,
            Threshold {
                value: 100,
                enabled: true,
            },
        );
        let p = plan(&s, &note(), &[], NOW);
        assert_eq!(p.len(), 4);
        assert_eq!(p[0].due_at_ms, NOW + (20 * 480 - 120) * 1000);
        assert_eq!(p[3].due_at_ms, NOW + note().resin_recovery_time * 1000);
    }
    #[test]
    fn reached_nodes_are_not_replayed_and_disabled_nodes_are_removed() {
        let mut s = Settings::default();
        s.resin.enabled = true;
        let mut n = note();
        n.current_resin = 180;
        n.resin_recovery_time = 20 * 480;
        assert_eq!(plan(&s, &n, &[], NOW).len(), 1);
        s.resin.thresholds[2].enabled = false;
        assert!(plan(&s, &n, &[], NOW).is_empty());
    }
    #[test]
    fn delivered_nodes_rearm_only_after_a_new_recovery_cycle() {
        let mut s = Settings::default();
        s.resin.enabled = true;
        let mut p = plan(&s, &note(), &[], NOW);
        p[0].delivered = true;
        let mut n = note();
        n.fetched_at_ms += 1000;
        n.resin_recovery_time -= 1;
        assert!(plan(&s, &n, &p, NOW + 1000)[0].delivered);
        n.current_resin = 20;
        n.resin_recovery_time += 60 * 480;
        assert!(!plan(&s, &n, &p, NOW + 1000)[0].delivered);
    }
    #[test]
    fn coins_interpolate_and_unlocked_resources_only() {
        let mut s = Settings::default();
        s.home_coin.enabled = true;
        assert_eq!(
            plan(&s, &note(), &[], NOW)[0].due_at_ms,
            NOW + 800 * 120 * 1000
        );
        let mut n = note();
        n.max_home_coin = 0;
        assert!(plan(&s, &n, &[], NOW).is_empty());
    }
    #[test]
    fn expedition_only_notifies_when_every_dispatched_character_finishes() {
        let mut s = Settings::default();
        s.expeditions = true;
        let mut n = note();
        n.expeditions = vec![
            crate::daily_note::Expedition {
                remained_time: 60,
                status: "Ongoing".into(),
                ..Default::default()
            },
            crate::daily_note::Expedition {
                remained_time: 90,
                status: "Ongoing".into(),
                ..Default::default()
            },
        ];
        assert_eq!(plan(&s, &n, &[], NOW)[0].due_at_ms, NOW + 90_000);
        n.expeditions.clear();
        assert!(plan(&s, &n, &[], NOW).is_empty());
    }
    #[test]
    fn validation_rejects_duplicates_ranges_and_too_many_nodes() {
        let mut s = Settings::default();
        s.resin.thresholds[1].value = 160;
        assert!(s.validate(None).is_err());
        s.resin.thresholds[1].value = 201;
        assert!(s.validate(None).is_err());
        s.resin.thresholds = (1..=13)
            .map(|value| Threshold {
                value,
                enabled: true,
            })
            .collect();
        assert!(s.validate(None).is_err());
    }
    #[test]
    fn low_capacity_teapot_uses_valid_defaults_without_blocking_resin() {
        let mut n = note();
        n.max_home_coin = 300;
        let mut s = Settings::default();
        s.resin.enabled = true;
        s.validate(Some(&n)).unwrap();
        assert_eq!(
            s.home_coin
                .thresholds
                .iter()
                .map(|t| t.value)
                .collect::<Vec<_>>(),
            vec![225, 250, 300]
        );
        s.home_coin.enabled = true;
        s.validate(Some(&n)).unwrap();
        s.home_coin.enabled = false;
        s.home_coin.thresholds[0].value = 500;
        s.validate(Some(&n)).unwrap();
        s.home_coin.enabled = true;
        assert!(s.validate(Some(&n)).is_err());
    }
    #[test]
    fn disabling_category_cancels_all_existing_nodes_and_bad_data_does_not_schedule() {
        let mut s = Settings::default();
        s.resin.enabled = true;
        let old = plan(&s, &note(), &[], NOW);
        s.resin.enabled = false;
        assert!(plan(&s, &note(), &old, NOW).is_empty());
        s.resin.enabled = true;
        let mut n = note();
        n.resin_recovery_time = 0;
        assert!(plan(&s, &n, &old, NOW).is_empty());
    }
    #[test]
    fn simultaneous_expedition_completions_produce_one_notification() {
        let mut s = Settings::default();
        s.expeditions = true;
        let mut n = note();
        n.expeditions = (0..5)
            .map(|_| crate::daily_note::Expedition {
                status: "Ongoing".into(),
                remained_time: 60,
                ..Default::default()
            })
            .collect();
        let mut jobs = plan(&s, &n, &[], NOW);
        assert_eq!(jobs.len(), 1);
        jobs[0].delivered = true;
        n.fetched_at_ms += 60_000;
        for expedition in &mut n.expeditions {
            expedition.status = "Finished".into();
            expedition.remained_time = 0;
        }
        let unchanged = plan(&s, &n, &jobs, NOW + 60_000);
        assert_eq!(unchanged.len(), 1);
        assert!(unchanged[0].delivered);
        for expedition in &mut n.expeditions {
            expedition.status = "Ongoing".into();
            expedition.remained_time = 7200;
        }
        assert!(!plan(&s, &n, &jobs, NOW + 60_000)[0].delivered);
    }
    #[test]
    fn fresh_snapshot_reaching_a_node_brings_existing_notification_forward() {
        let mut s = Settings::default();
        s.resin.enabled = true;
        let mut old = plan(&s, &note(), &[], NOW);
        for job in &mut old {
            job.scheduled = true;
        }
        let mut n = note();
        n.current_resin = 200;
        n.resin_recovery_time = 0;
        n.fetched_at_ms += 30_000;
        let updated = plan(&s, &n, &old, NOW + 30_000);
        assert_eq!(updated.len(), 3);
        assert!(updated
            .iter()
            .all(|j| j.due_at_ms == n.fetched_at_ms && !j.scheduled));
        assert!(plan(&s, &n, &[], NOW + 30_000).is_empty());
    }
}
