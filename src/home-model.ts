import type { DailyNoteData, HcScheduleData, RoleCombatData, SpiralAbyss, WishSummary } from "./api";

export function progressPercent(value: number, max: number): number {
  return Number.isFinite(value) && Number.isFinite(max) && max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 0;
}

export function pityValue(summary: WishSummary | undefined, rank: 4 | 5): number | null {
  if (!summary || summary.total_count <= 0 || summary.total_unknown > 0) return null;
  const value = rank === 5 ? summary.last_orange_pull : summary.last_purple_pull;
  const max = rank === 5 ? summary.guarantee_orange_threshold : summary.guarantee_purple_threshold;
  return Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

export function dailyProgress(data: DailyNoteData, now = Date.now()) {
  const daily = data.daily_task;
  const total = daily && daily.total_num > 0 ? daily.total_num : data.total_task_num;
  const done = daily && daily.total_num > 0 ? daily.finished_num : data.finished_task_num;
  const reward = daily?.is_extra_task_reward_received ?? data.is_extra_task_reward_received;
  const elapsed = Math.max(0, (now - data.fetched_at_ms) / 1000);
  const finished = data.expeditions.filter(e => e.status === "Finished" || e.remained_time <= elapsed).length;
  return { total, done, reward, finished, taskCaption: reward ? "奖励已领取" : total > 0 && done >= total ? "额外奖励待领取" : "今日尚未完成" };
}

export interface CycleSummary { value: string; end: number; caption: string }
const active = (start: number, end: number, now: number) => start > 0 && start <= now && end > now;

export function abyssSummary(records: SpiralAbyss[], now = Date.now() / 1000): CycleSummary | undefined {
  const data = records.find(d => active(d.start_time, d.end_time, now));
  return data ? { value: data.is_unlock ? `${data.total_star} / 36 星` : "尚未解锁", end: data.end_time, caption: `第 ${data.schedule_id} 期` } : undefined;
}
export function theaterSummary(records: RoleCombatData[], now = Date.now() / 1000): CycleSummary | undefined {
  const data = records.find(d => active(d.schedule.start_time, d.schedule.end_time, now));
  return data ? { value: data.has_data ? `${data.stat.max_round_id} 幕` : "尚未挑战", end: data.schedule.end_time, caption: `第 ${data.schedule.schedule_id} 期` } : undefined;
}
export function hardSummary(records: HcScheduleData[], now = Date.now() / 1000): CycleSummary | undefined {
  const data = records.find(d => active(d.schedule.start_time, d.schedule.end_time, now) && d.schedule.is_valid);
  const entry = data?.single.has_data ? data.single : data?.mp;
  const done = entry?.challenge.filter(c => c.second > 0 || c.teams.length > 0).length ?? 0;
  return data ? { value: entry?.has_data ? `${done} / 3 场` : "尚未挑战", end: data.schedule.end_time, caption: data.schedule.name || `第 ${data.schedule.schedule_id} 期` } : undefined;
}

export function remaining(end: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil(end - now / 1000));
  if (!seconds) return "本期已结束";
  if (seconds >= 86400) return `剩余 ${Math.ceil(seconds / 86400)} 天`;
  if (seconds >= 3600) return `剩余 ${Math.ceil(seconds / 3600)} 小时`;
  return `剩余 ${Math.ceil(seconds / 60)} 分钟`;
}
