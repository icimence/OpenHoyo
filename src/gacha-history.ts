import type { EventHistory } from "./api";
import { esc, iconSrc } from "./gacha-view-utils";

let selectedEvent = 0;

export function renderEventHistory(body: HTMLElement, events: EventHistory[]): void {
  if (events.length === 0) {
    body.innerHTML = `<div class="empty-users"><div class="title">暂无历史记录</div></div>`;
    return;
  }
  selectedEvent = Math.min(selectedEvent, events.length - 1);
  const selected = events[selectedEvent];
  const eventLabel = (event: EventHistory): string => {
    if (event.query_type === 302) return "武器活动";
    if (event.query_type === 500) return "集录祈愿";
    if (event.query_type === 200) return "常驻祈愿";
    if (event.query_type === 100) return "新手祈愿";
    return "角色活动";
  };
  const tiles = (items: EventHistory["items"]): string => items.map((item) => {
    const quality = item.rank_type === 5 ? "orange" : item.rank_type === 4 ? "purple" : "blue";
    const name = item.name || "未知物品";
    return `<div class="event-item" title="${esc(name)} × ${item.count}">
      <div class="tile-face ${quality}">${esc(name.slice(0, 1))}<img src="${iconSrc(name)}" loading="lazy" onerror="this.remove()"/></div>
      <span class="event-item-count">${item.count}</span>
      <span class="event-item-name">${esc(name)}</span>
    </div>`;
  }).join("");
  const list = events.map((event, index) => {
    const orange = event.up_orange.length ? event.up_orange : event.items.filter((item) => item.rank_type === 5).slice(0, 2);
    const purple = event.up_purple.length ? event.up_purple : event.items.filter((item) => item.rank_type === 4).slice(0, 3);
    const featured = (items: EventHistory["items"]): string => items.map((item) =>
      `<span class="tile-face ${item.rank_type === 5 ? "orange" : "purple"}" title="${esc(item.name)} × ${item.count}">${esc(item.name.slice(0, 1))}<img src="${iconSrc(item.name)}" loading="lazy" onerror="this.remove()"/><em>${item.count}</em></span>`,
    ).join("");
    return `<button class="event-row ${index === selectedEvent ? "active" : ""}" data-event="${index}" aria-pressed="${index === selectedEvent}">
      <span class="event-row-title"><b>${esc(event.version || eventLabel(event))} ${esc(event.name)}</b><strong>${event.total_count} 抽</strong></span>
      <span class="event-row-icons"><span class="event-feature-group">${featured(orange)}</span><span class="event-feature-group">${featured(purple)}</span></span>
      <span class="event-row-date">${esc(event.from.slice(0, 10))} — ${esc(event.to.slice(0, 10))}</span>
    </button>`;
  }).join("");
  const qualitySection = (rank: number, label: string): string => {
    const items = selected.items.filter((item) => item.rank_type === rank);
    return items.length ? `<section class="event-quality"><h3>${label} <small>${items.reduce((sum, item) => sum + item.count, 0)} 次</small></h3><div class="event-item-grid">${tiles(items)}</div></section>` : "";
  };
  body.innerHTML = `<div class="event-history-layout">
    <div class="event-list" aria-label="祈愿活动期">${list}</div>
    <div class="event-detail">
      <div class="event-detail-header"><div><span>${eventLabel(selected)}</span><h2>${esc(selected.name)}</h2><p>${esc(selected.from.slice(0, 10))} — ${esc(selected.to.slice(0, 10))}</p></div><strong>${selected.total_count} 抽</strong></div>
      ${qualitySection(5, "五星")}${qualitySection(4, "四星")}${qualitySection(3, "三星")}
    </div>
  </div>`;
  body.querySelectorAll<HTMLButtonElement>("[data-event]").forEach((button) => {
    button.addEventListener("click", () => {
      const previous = body.querySelector<HTMLElement>(".event-list")?.scrollTop ?? 0;
      selectedEvent = Number(button.dataset.event);
      renderEventHistory(body, events);
      const list = body.querySelector<HTMLElement>(".event-list");
      if (list) list.scrollTop = previous;
    });
  });
}
