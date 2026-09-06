// 祈愿记录页（对应原版 GachaLogPage + GachaLogViewModel）
import { api, errText, type GachaArchiveDto, type GachaStatisticsDto, type NameCountEntry, type WishSummary } from "./api";
import { closeDialog, confirmDialog, onDialogCancel, onDialogOk, openDialog, runWithOkGuard, setOkEnabled, setStatus, toast } from "./ui";

// ---------------------------------------------------------------------------
// 模块状态与进度事件（单例监听，避免重复注册）
// ---------------------------------------------------------------------------

interface GachaPageContext {
  /** 供 SToken 刷新使用的当前用户与角色 */
  currentUser: { id: number; isOversea: boolean; gameUid: string | null } | null;
}

let ctx: GachaPageContext = { currentUser: null };
let archives: GachaArchiveDto[] = [];
let selectedArchive: number | null = null;
let stats: GachaStatisticsDto | null = null;
let progressText = "";
let activeTab = "overview";
let activePool = 301;
let refreshMenuOpen = false;
let listenerReady = false;

/** 本地打包的物品图标（scripts/fetch-wiki-icons.mjs 从官方观测枢 wiki 拉取） */
function iconSrc(name: string): string {
  return `/gacha-icons/${encodeURIComponent(name)}.webp`;
}

const POOL_NAMES: Record<number, string> = {
  100: "新手祈愿",
  200: "常驻祈愿",
  301: "角色活动祈愿",
  302: "武器活动祈愿",
  400: "角色活动祈愿-2",
  500: "集录祈愿",
};

interface ProgressItem {
  name: string;
  item_type: string;
  rank_type: number;
}

interface GachaProgressEvent {
  uid: string;
  gacha_type: number;
  fetched: number;
  done: boolean;
  authkey_timeout: boolean;
  message: string;
  items: ProgressItem[];
}

export function renderGachaPage(content: HTMLElement, context: GachaPageContext): void {
  ctx = context;
  if (!listenerReady) {
    listenerReady = true;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<GachaProgressEvent>("gacha://progress", (event) => {
        const p = event.payload;
        progressText = p.message;
        updateProgressLine();
        updateProgressDialog(p);
      });
    })();
  }
  void load().catch((e: unknown) => toast(errText(e), "error"));
  content.innerHTML = `<div class="page-header"><h2>祈愿记录</h2><p>正在加载…</p></div>`;
}

async function load(): Promise<void> {
  archives = await api.gachaArchives();
  if (selectedArchive === null || !archives.some((a) => a.id === selectedArchive)) {
    selectedArchive = archives[0]?.id ?? null;
  }
  stats = selectedArchive !== null ? await api.gachaStatistics(selectedArchive) : null;
  const content = document.getElementById("content")!;
  render(content);
}

function updateProgressLine(): void {
  const el = document.getElementById("gacha-progress");
  if (el) {
    el.textContent = progressText;
  }
}

// ---------------------------------------------------------------------------
// 拉取进度对话框（对应原版 GachaLogRefreshProgressDialog：标题 + 正在获取 {池} + 本页物品）
// ---------------------------------------------------------------------------

function updateProgressDialog(p: GachaProgressEvent): void {
  const header = document.getElementById("gp-header");
  if (!header) {
    return;
  }
  header.textContent = p.authkey_timeout
    ? "祈愿记录 URL 已失效，请重新获取"
    : `正在获取 ${POOL_NAMES[p.gacha_type] ?? "祈愿记录"}`;

  const count = document.getElementById("gp-count");
  if (count) {
    count.textContent = p.fetched > 0 ? `已获取 ${p.fetched} 条` : "";
  }

  const grid = document.getElementById("gp-grid");
  if (grid && p.items.length > 0) {
    grid.innerHTML = p.items
      .map((it) => {
        const q = it.rank_type === 5 ? "orange" : it.rank_type === 4 ? "purple" : "blue";
        return `<div class="gp-tile ${q}">${esc(it.name.slice(0, 1))}<img src="${iconSrc(it.name)}" onerror="this.remove()" loading="lazy"/></div>`;
      })
      .join("");
  }
}

function openProgressDialog(): void {
  openDialog(
    "获取祈愿物品中",
    `
    <div class="gp-header" id="gp-header">正在连接…</div>
    <div class="gp-count" id="gp-count"></div>
    <div class="gp-grid" id="gp-grid"></div>
    <div class="gp-spinner"><div class="spin"></div></div>`,
    null,
    { cancelable: false },
  );
}

// ---------------------------------------------------------------------------
// 页面渲染
// ---------------------------------------------------------------------------

function render(content: HTMLElement): void {
  const toolbar = `
    <div class="gacha-toolbar">
      <div class="gacha-toolbar-left">
        <select id="gacha-archive-select" class="gacha-select" ${archives.length === 0 ? "disabled" : ""}>
          ${archives.length > 0
            ? archives.map((a) => `<option value="${a.id}" ${a.id === selectedArchive ? "selected" : ""}>UID ${a.uid}</option>`).join("")
            : '<option>暂无存档</option>'}
        </select>
        <div class="refresh-wrap">
          <button class="primary" id="gacha-refresh-btn">刷新 ▾</button>
          <div id="gacha-refresh-menu" class="refresh-menu ${refreshMenuOpen ? "" : "hidden"}">
            <button data-refresh="stoken">SToken 刷新</button>
            <button data-refresh="webcache">网页缓存刷新</button>
            <button data-refresh="manual">手动输入 URL</button>
          </div>
        </div>
        <button id="gacha-remove-btn" ${archives.length > 0 ? "" : "disabled"}>删除存档</button>
      </div>
      <div class="gacha-progress" id="gacha-progress">${esc(progressText)}</div>
    </div>`;

  if (archives.length === 0 || !stats) {
    content.innerHTML = `
      <div class="page-header"><h2>祈愿记录</h2><p>管理祈愿记录存档</p></div>
      ${toolbar}
      <div class="empty-users">
        <svg viewBox="0 0 16 16" width="52" height="52"><use href="#i-gacha"/></svg>
        <div class="title">尚未获取任何祈愿记录</div>
        <div class="hint">点击「刷新」按钮，通过 SToken 或网页缓存方式获取</div>
      </div>`;
    wireToolbar(content);
    return;
  }

  const tabs = [
    { id: "overview", label: "总览" },
    { id: "history", label: "历史" },
    { id: "avatar", label: "角色" },
    { id: "weapon", label: "武器" },
    { id: "countdown", label: "计时", disabled: true },
    { id: "global", label: "全球祈愿统计", disabled: true },
  ]
    .map(
      (t) =>
        `<button class="gacha-tab ${t.id === activeTab ? "active" : ""} ${t.disabled ? "disabled-tab" : ""}" data-tab="${t.id}">${t.label}</button>`,
    )
    .join("");

  content.innerHTML = `
    <div class="page-header"><h2>祈愿记录</h2><p>UID ${esc(stats.uid)} · 共 ${stats.total_count} 抽</p></div>
    ${toolbar}
    <div class="gacha-tabs-row">
      <div class="gacha-tabs">${tabs}</div>
    </div>
    <div id="gacha-body" class="gacha-body"></div>`;

  wireToolbar(content);
  content.querySelectorAll<HTMLButtonElement>(".gacha-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("disabled-tab")) {
        toast(`${btn.textContent} · 未实现`, "info");
        return;
      }
      activeTab = btn.dataset.tab!;
      render(content);
    });
  });

  const body = content.querySelector<HTMLElement>("#gacha-body")!;
  switch (activeTab) {
    case "overview":
      renderOverview(body);
      break;
    case "history":
      renderHistory(body);
      break;
    case "avatar":
      renderNameCount(body, stats.avatars, "avatar");
      break;
    case "weapon":
      renderNameCount(body, stats.weapons, "weapon");
      break;
    default:
      body.innerHTML = "";
  }
}

function wireToolbar(content: HTMLElement): void {
  const select = content.querySelector<HTMLSelectElement>("#gacha-archive-select");
  select?.addEventListener("change", () => {
    selectedArchive = Number(select.value);
    void load().catch((e: unknown) => toast(errText(e), "error"));
  });

  const refreshBtn = content.querySelector<HTMLButtonElement>("#gacha-refresh-btn");
  const menu = content.querySelector<HTMLElement>("#gacha-refresh-menu");
  refreshBtn?.addEventListener("click", () => {
    refreshMenuOpen = menu?.classList.contains("hidden") ?? false;
    menu?.classList.toggle("hidden");
  });
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.closest(".refresh-wrap")) {
      menu?.classList.add("hidden");
    }
  });

  menu?.querySelectorAll<HTMLButtonElement>("[data-refresh]").forEach((btn) => {
    btn.addEventListener("click", () => {
      menu.classList.add("hidden");
      const kind = btn.dataset.refresh!;
      if (kind === "stoken") {
        void refreshByStoken();
      } else if (kind === "webcache") {
        void refreshByWebCache();
      } else {
        openManualDialog();
      }
    });
  });

  content.querySelector<HTMLButtonElement>("#gacha-remove-btn")?.addEventListener("click", () => {
    if (selectedArchive === null) {
      return;
    }
    const uid = archives.find((a) => a.id === selectedArchive)?.uid ?? "";
    void (async () => {
      const confirmed = await confirmDialog(
        "删除存档",
        `确定删除 UID ${uid} 的祈愿记录存档吗？<br/>该 UID 的全部祈愿记录将被永久删除，此操作不可恢复。`,
      );
      if (!confirmed) {
        return;
      }
      await api.gachaRemoveArchive(selectedArchive!);
      selectedArchive = null;
      toast("已删除存档", "success");
      await load();
    })().catch((e: unknown) => toast(errText(e), "error"));
  });
}

// ---------------------------------------------------------------------------
// 刷新动作
// ---------------------------------------------------------------------------

async function runRefresh(task: () => Promise<string>): Promise<void> {
  progressText = "正在获取祈愿记录…";
  updateProgressLine();
  openProgressDialog();
  try {
    const uid = await task();
    toast(`已刷新 UID ${uid} 的祈愿记录`, "success");
  } catch (e) {
    toast(errText(e), "error");
  } finally {
    closeDialog();
    progressText = "";
    updateProgressLine();
    await load().catch((e: unknown) => toast(errText(e), "error"));
  }
}

async function refreshByStoken(): Promise<void> {
  if (!ctx.currentUser) {
    toast("请先在用户页登录", "error");
    return;
  }
  if (ctx.currentUser.isOversea) {
    toast("国际服账号不支持 SToken 刷新", "error");
    return;
  }
  if (!ctx.currentUser.gameUid) {
    toast("当前用户没有国服游戏角色", "error");
    return;
  }
  await runRefresh(() => api.gachaRefreshByStoken(ctx.currentUser!.id, ctx.currentUser!.gameUid!));
}

async function refreshByWebCache(): Promise<void> {
  await runRefresh(() => api.gachaRefreshByWebCache());
}

function openManualDialog(): void {
  openDialog(
    "手动输入 URL",
    `
    <label>祈愿记录页面 URL
      <textarea id="gacha-url" rows="6" placeholder="粘贴游戏内祈愿记录页面的完整 URL（包含 authkey 参数）"></textarea>
    </label>
    <label class="check-row">
      <input id="gacha-aggressive" type="checkbox"/>
      全量刷新（忽略本地缓存，重新拉取全部记录）
    </label>
    <p class="hint">URL 可在游戏内打开祈愿记录页面后，从网页缓存或浏览器历史中获取</p>`,
    "获取",
  );
  const input = document.getElementById("gacha-url") as HTMLTextAreaElement;
  input.addEventListener("input", () => {
    setOkEnabled(input.value.trim().length > 0);
  });
  setOkEnabled(false);

  onDialogOk(() =>
    runWithOkGuard(async () => {
      const aggressive = (document.getElementById("gacha-aggressive") as HTMLInputElement).checked;
      setStatus("正在获取…");
      const raw = input.value.trim();
      closeDialog();
      await runRefresh(() => api.gachaRefreshByManual(raw, aggressive));
    }),
  );
  onDialogCancel(closeDialog);
}

// ---------------------------------------------------------------------------
// 总览（4 张 StatisticsCard）
// ---------------------------------------------------------------------------

function renderOverview(body: HTMLElement): void {
  const s = stats!;
  const cards: WishSummary[] = [s.avatar_wish, s.weapon_wish, s.standard_wish, s.chronicled_wish];
  body.innerHTML = `<div class="stats-cards">${cards.map((w) => statsCard(w)).join("")}</div>`;

  // 五星列表的展开/收起
  body.querySelectorAll<HTMLButtonElement>(".orange-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      explicitSectionState.set(btn.dataset.section!, btn.dataset.open === "1");
      renderOverview(body);
    });
  });
}

/** 五星出货列表：平铺（图标+正下方抽数）+ 智能展开收起 */
function orangeListHtml(w: WishSummary): string {
  const entries = w.orange_list.slice().reverse(); // 最新在前
  if (entries.length === 0) {
    return `<div class="orange-empty">暂无五星记录</div>`;
  }

  const key = `orange-${w.name}`;
  const smartOpen = entries.length <= ORANGE_COLLAPSE_THRESHOLD;
  const isExpanded = explicitSectionState.get(key) ?? smartOpen;
  const visible = isExpanded ? entries : entries.slice(0, ORANGE_COLLAPSE_THRESHOLD);

  const inner = `<div class="orange-flat">${visible
    .map(
      (o) => `<div class="flat-tile" title="${esc(o.name)} · ${o.pull} 抽 · ${esc(o.time.slice(0, 10))}${w.has_up ? (o.is_up ? " · 命中UP" : " · 歪了") : ""}">
        <div class="tile-face orange">${esc(o.name.slice(0, 1))}<img src="${iconSrc(o.name)}" onerror="this.remove()" loading="lazy"/>${w.has_up ? `<span class="up-badge ${o.is_up ? "hit" : "lost"}">${o.is_up ? "UP" : "歪"}</span>` : ""}</div>
        <span class="flat-count orange">${o.pull}</span>
      </div>`,
    )
    .join("")}</div>`;

  const footer =
    entries.length > ORANGE_COLLAPSE_THRESHOLD
      ? `<button class="section-toggle orange-toggle" data-section="${key}" data-open="${isExpanded ? "0" : "1"}">${isExpanded ? "收起" : `展开全部 ${entries.length} 个五星`}</button>`
      : "";

  return `${inner}${footer}`;
}

function statsCard(w: WishSummary): string {
  const orangePct = (w.orange_percent * 100).toFixed(1);
  const purplePct = (w.purple_percent * 100).toFixed(1);
  const bluePct = (w.blue_percent * 100).toFixed(1);
  const orangeBar = Math.min(100, (w.last_orange_pull / w.guarantee_orange_threshold) * 100);
  const purpleBar = Math.min(100, (w.last_purple_pull / w.guarantee_purple_threshold) * 100);

  return `
  <div class="stats-card">
    <div class="stats-title-row">
      <div class="stats-title">${esc(w.name)}</div>
      ${w.has_up ? `<span class="pity-state ${w.guaranteed ? "lost" : ""}" title="${w.guaranteed ? "最近一个五星是歪的，下一个五星必为 UP" : "下一个五星有 50% 概率为 UP"}">${w.guaranteed ? "大保底" : "小保底"}</span>` : ""}
    </div>
    <div class="stats-total"><span class="big">${w.total_count}</span> 抽</div>
    <div class="stats-time">${esc(w.from_time.slice(0, 10))} ~ ${esc(w.to_time.slice(0, 10))}</div>

    <div class="gauge-row">
      <div class="gauge-label">距上个五星 <b>${w.last_orange_pull}</b>/${w.guarantee_orange_threshold} 抽</div>
      <div class="gauge"><div class="gauge-fill orange" style="width:${orangeBar}%"></div></div>
    </div>
    <div class="gauge-row">
      <div class="gauge-label">距上个四星 <b>${w.last_purple_pull}</b>/${w.guarantee_purple_threshold} 抽</div>
      <div class="gauge"><div class="gauge-fill purple" style="width:${purpleBar}%"></div></div>
    </div>

    <div class="stats-quality">
      <div class="q orange">
        <span class="q-name">五星${w.has_up ? ` <span class="q-sub">中${w.total_up_orange} 歪${w.total_lost_orange}</span>` : ""}</span>
        <span class="q-count">${w.total_orange}</span>
        <span class="q-pct">${orangePct}%</span>
      </div>
      <div class="q purple"><span class="q-name">四星</span><span class="q-count">${w.total_purple}</span><span class="q-pct">${purplePct}%</span></div>
      <div class="q blue"><span class="q-name">三星</span><span class="q-count">${w.total_blue}</span><span class="q-pct">${bluePct}%</span></div>
    </div>

    <div class="stats-avg">
      五星平均 ${w.average_orange_pull.toFixed(2)}${w.has_up && w.total_up_orange > 0 ? ` · UP平均 ${w.average_up_orange_pull.toFixed(2)}` : ""} · 最非 ${w.max_orange_pull} · 最欧 ${w.min_orange_pull || w.max_orange_pull}
    </div>

    ${orangeListHtml(w)}
  </div>`;
}

// ---------------------------------------------------------------------------
// 历史（左池子列表 + 右分组网格）
// ---------------------------------------------------------------------------

function renderHistory(body: HTMLElement): void {
  const s = stats!;
  if (s.history.length === 0) {
    body.innerHTML = `<div class="empty-users"><div class="title">暂无记录</div></div>`;
    return;
  }
  if (!s.history.some((p) => p.query_type === activePool)) {
    activePool = s.history[0].query_type;
  }

  const poolList = s.history
    .map(
      (p) =>
        `<button class="pool-item ${p.query_type === activePool ? "active" : ""}" data-pool="${p.query_type}">
          ${esc(p.name)}<span class="pool-count">${p.groups.reduce((acc, g) => acc + g.count, 0)}</span>
        </button>`,
    )
    .join("");

  const pool = s.history.find((p) => p.query_type === activePool)!;
  // UP 概念仅存在于角色/武器活动池；常驻与集录的历史条目不显示 UP/歪徽标
  const poolHasUp = pool.query_type === 301 || pool.query_type === 302;
  const groups = pool.groups
    .map((g) => {
      const tiles = g.items
        .map((it) => {
          const q = it.rank_type === 5 ? "orange" : it.rank_type === 4 ? "purple" : "blue";
          const upBadge =
            poolHasUp && it.rank_type === 5 ? `<span class="up-badge ${it.is_up ? "hit" : "lost"}">${it.is_up ? "UP" : "歪"}</span>` : "";
          return `<div class="wish-tile ${q} ${it.rank_type === 5 ? "five" : ""}" title="${esc(it.name)} · ${esc(it.time)}">
            <div class="tile-face ${q}">${esc(it.name.slice(0, 1))}<img src="${iconSrc(it.name)}" onerror="this.remove()" loading="lazy"/>${upBadge}</div>
            <div class="tile-name">${esc(it.name)}</div>
          </div>`;
        })
        .join("");
      return `<div class="wish-group"><div class="wish-tiles">${tiles}</div><div class="group-count">${g.count} 抽</div></div>`;
    })
    .join("");

  body.innerHTML = `
    <div class="history-layout">
      <div class="pool-list">${poolList}</div>
      <div class="group-scroll">${groups || '<div class="empty-users"><div class="title">暂无记录</div></div>'}</div>
    </div>`;

  body.querySelectorAll<HTMLButtonElement>(".pool-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      activePool = Number(btn.dataset.pool);
      renderHistory(body);
    });
  });
}

// ---------------------------------------------------------------------------
// 角色 / 武器（对应原版 Avatar/Weapon Pivot：按品质分卡片区 + 平铺网格）
// ---------------------------------------------------------------------------

/** 显式展开/收起状态（未设置时用智能默认） */
const explicitSectionState = new Map<string, boolean>();
const COLLAPSE_THRESHOLD = 12;
/** 总览卡五星列表的展开阈值（平铺一行约 4 个，两行起步） */
const ORANGE_COLLAPSE_THRESHOLD = 8;

function renderNameCount(body: HTMLElement, entries: NameCountEntry[], kind: "avatar" | "weapon"): void {
  if (entries.length === 0) {
    body.innerHTML = `<div class="empty-users"><div class="title">暂无${kind === "avatar" ? "角色" : "武器"}记录</div></div>`;
    return;
  }

  const rankNames: Record<number, string> = { 5: "五星", 4: "四星", 3: "三星" };
  const ranks = kind === "avatar" ? [5, 4] : [5, 4, 3];

  const sections = ranks
    .map((rank) => {
      const items = entries.filter((e) => e.rank_type === rank);
      if (items.length === 0) {
        return "";
      }
      const key = `${kind}-${rank}`;
      const q = rank === 5 ? "orange" : rank === 4 ? "purple" : "blue";
      const smartOpen = items.length <= COLLAPSE_THRESHOLD;
      const isExpanded = explicitSectionState.get(key) ?? smartOpen;
      const visible = isExpanded ? items : items.slice(0, COLLAPSE_THRESHOLD);

      const tiles = visible
        .map(
          (e) => `<div class="flat-tile" title="${esc(e.name)} × ${e.count}">
            <div class="tile-face ${q}">${esc(e.name.slice(0, 1))}<img src="${iconSrc(e.name)}" onerror="this.remove()" loading="lazy"/></div>
            <span class="flat-count ${q}">${e.count}</span>
          </div>`,
        )
        .join("");

      const footer =
        items.length > COLLAPSE_THRESHOLD
          ? `<button class="section-toggle" data-section="${key}" data-open="${isExpanded ? "0" : "1"}">${isExpanded ? "收起" : `展开全部 ${items.length} 项`}</button>`
          : "";

      return `
        <div class="section-card">
          <div class="section-header" data-toggle="${key}">
            <span class="section-title ${q}">${rankNames[rank]}</span>
            <span class="section-count">${items.length} 种</span>
          </div>
          <div class="section-body">${tiles}</div>
          ${footer}
        </div>`;
    })
    .join("");

  body.innerHTML = sections;

  body.querySelectorAll<HTMLButtonElement>(".section-toggle").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const key = btn.dataset.section!;
      explicitSectionState.set(key, btn.dataset.open === "1");
      renderNameCount(body, entries, kind);
    });
  });
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
