import type { DailyNoteData } from "./api";
import { escapeHtml as esc } from "./html";
import { dailyProgress, progressPercent } from "./home-model";

export function meterHtml(label: string, value: number, max: number, cls = ""): string {
  return `<div class="overview-meter ${cls}" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${Math.max(1,max)}" aria-valuenow="${Math.max(0,Math.min(max,value))}"><span style="width:${progressPercent(value,max)}%"></span></div>`;
}

export function transformerText(data: DailyNoteData | undefined): string {
  if (!data) return "参量质变仪 · 尚未同步";
  if (!data.transformer?.obtained) return "参量质变仪 · 未获得";
  const time = data.transformer.recovery_time;
  if (time?.reached) return "参量质变仪已就绪";
  return time ? `质变仪 · ${time.day > 0 ? `${time.day} 天 ` : ""}${time.hour} 小时后可用` : "参量质变仪 · 状态未知";
}

/** 与参考图一致的树脂大格 + 四个状态格；未知数据不显示虚构的零。 */
export function dailyOverviewHtml(data?: DailyNoteData): string {
  const p = data ? dailyProgress(data) : undefined;
  const tile = (icon: string, name: string, value: string, caption: string, amount?: number, max?: number, warn = false) => `<div class="note-tile" aria-label="${esc(`${name} ${value} ${caption}`)}"><img src="${icon}" alt=""/><span class="note-tile-value">${esc(value)}</span><span class="note-tile-label">${esc(name)}</span>${amount !== undefined && max !== undefined ? meterHtml(name,amount,max) : '<div class="overview-meter"></div>'}<span class="note-tile-caption ${warn ? "note-attention" : ""}">${esc(caption)}</span></div>`;
  return `<div class="note-overview ${data ? "" : "note-pending"}">
    <div class="note-resin"><img src="/icons/ui/UI_ItemIcon_106.png" alt=""/><strong>${data ? data.current_resin : "—"}<small>${data ? ` / ${data.max_resin}` : ""}</small></strong><span>原粹树脂</span>${data ? meterHtml("原粹树脂", data.current_resin,data.max_resin) : '<div class="overview-meter"></div>'}<small>${data ? data.resin_recovery_time > 0 ? `${Math.floor(data.resin_recovery_time / 3600)}小时${Math.floor(data.resin_recovery_time % 3600 / 60)}分后恢复` : "已恢复至上限" : "尚未同步"}</small></div>
    ${tile("/icons/ui/UI_ItemIcon_204.png","洞天宝钱",data && data.max_home_coin > 0 ? `${data.current_home_coin.toLocaleString()} / ${data.max_home_coin.toLocaleString()}` : data ? "未解锁" : "—",data?.max_home_coin === 0 ? "尚未开启尘歌壶" : "当前储量",data?.current_home_coin,data?.max_home_coin)}
    ${tile("/icons/ui/UI_MarkTower.png","周本减免",data ? `${data.remain_resin_discount_num} / ${data.resin_discount_num_limit}` : "—","剩余减免次数",data?.remain_resin_discount_num,data?.resin_discount_num_limit)}
    ${tile("/icons/ui/UI_MarkQuest_Events_Proce.png","每日委托",p ? `${p.done} / ${p.total}` : "—",p?.taskCaption ?? "尚未同步",p?.done,p?.total,!!p && !p.reward && p.done >= p.total && p.total > 0)}
    ${tile("/icons/nav/DailyNote.png","探索派遣",p && data ? `${p.finished} / ${data.current_expedition_num}` : "—",p && data ? data.current_expedition_num === 0 ? "尚未派遣" : p.finished === data.current_expedition_num ? "派遣已全部完成" : `已完成 ${p.finished} 人` : "尚未同步",p?.finished,data?.current_expedition_num)}
  </div>`;
}
