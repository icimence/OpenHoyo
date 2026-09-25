import { api, errText, type GachaCountdown } from "./api";
import { esc, iconSrc } from "./gacha-view-utils";

let cache: GachaCountdown[] | null = null;

export async function renderCountdown(body: HTMLElement): Promise<void> {
  body.innerHTML = `<div class="empty-users"><div class="title">正在加载计时数据…</div></div>`;
  try {
    const entries = cache ?? await api.gachaCountdown();
    cache = entries;
    if (!body.isConnected) return;
    const section = (title: string, filtered: GachaCountdown[]): string => `<section class="countdown-section">
      <h2>${title}</h2>
      ${filtered.length ? filtered.map((entry) => `<div class="countdown-item">
        <div class="tile-face ${entry.rank_type === 5 ? "orange" : "purple"}">${esc(entry.name.slice(0, 1))}<img src="${iconSrc(entry.name)}" loading="lazy" onerror="this.remove()"/></div>
        <div class="countdown-copy"><strong>${esc(entry.name)}</strong><span>距离上次 UP 已有 <b>${entry.days}</b> 天</span><small>上次 UP：${esc(entry.last_up)} · ${esc(entry.version)}</small></div>
      </div>`).join("") : '<p class="countdown-empty">暂无记录</p>'}
    </section>`;
    const select = (kind: "角色" | "武器", rank: number) => entries.filter((entry) => entry.item_type === kind && entry.rank_type === rank);
    body.innerHTML = `<div class="countdown-grid">
      ${section("五星角色", select("角色", 5))}
      ${section("四星角色", select("角色", 4))}
      <div>${section("五星武器", select("武器", 5))}${section("四星武器", select("武器", 4))}</div>
    </div>`;
  } catch (error) {
    if (body.isConnected) body.innerHTML = `<div class="empty-users"><div class="title">计时数据加载失败</div><div class="hint">${esc(errText(error))}</div></div>`;
  }
}
