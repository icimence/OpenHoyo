// 祈愿记录页（对应原版 GachaLogPage + GachaLogViewModel）
import { api, errText, isApiError, type GachaArchiveDto, type GachaStatisticsDto, type NameCountEntry, type WishSummary } from "./api";
import { closeDialog, confirmDialog, onDialogCancel, onDialogOk, openDialog, runWithOkGuard, setOkEnabled, setStatus, toast } from "./ui";
import { importUigf } from "./gacha-import";
import { renderEventHistory } from "./gacha-history";
import { renderCountdown } from "./gacha-countdown";
import { combineLimitedOrange } from "./gacha-combined";
import { esc, iconSrc } from "./gacha-view-utils";

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
let refreshMenuOpen = false;
let moreMenuOpen = false;
let listenerReady = false;
let outsideClickReady = false;
let combineAvatarOrange = false;

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
  // 胡桃式命令栏：一行内 [UID ▾] [页签] ←弹性→ [进度] [刷新 ▾] [⋯ 更多]
  // UIGF 导入/导出、删除存档是次要命令，全部收进 ⋯ 菜单，避免按钮堆砌
  const hasArchive = archives.length > 0;
  const tabs = hasArchive
    ? [
        { id: "overview", label: "总览" },
        { id: "history", label: "历史" },
        { id: "avatar", label: "角色" },
        { id: "weapon", label: "武器" },
        { id: "countdown", label: "计时" },
      ]
        .map(
          (t) =>
            `<button class="gacha-tab ${t.id === activeTab ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`,
        )
        .join("")
    : "";
  const toolbar = `
    <div class="gacha-commandbar">
      <select id="gacha-archive-select" class="gacha-select" ${hasArchive ? "" : "disabled"}>
        ${hasArchive
          ? archives.map((a) => `<option value="${a.id}" ${a.id === selectedArchive ? "selected" : ""}>UID ${a.uid}</option>`).join("")
          : '<option>暂无存档</option>'}
      </select>
      <div class="gacha-tabs">${tabs}</div>
      <div class="gacha-progress" id="gacha-progress">${esc(progressText)}</div>
      <div class="refresh-wrap">
        <button class="primary" id="gacha-refresh-btn"><svg aria-hidden="true"><use href="#i-refresh"/></svg>刷新 ▾</button>
        <div id="gacha-refresh-menu" class="commandbar-menu align-right ${refreshMenuOpen ? "" : "hidden"}">
          <button data-refresh="stoken"><svg aria-hidden="true"><use href="#i-key"/></svg>SToken 刷新</button>
          <button data-refresh="webcache"><svg aria-hidden="true"><use href="#i-browser"/></svg>网页缓存刷新</button>
          <button data-refresh="manual"><svg aria-hidden="true"><use href="#i-link"/></svg>手动输入 URL</button>
        </div>
      </div>
      <div class="refresh-wrap more-wrap">
        <button id="gacha-more-btn" class="more-btn" title="更多">⋯</button>
        <div id="gacha-more-menu" class="commandbar-menu align-right ${moreMenuOpen ? "" : "hidden"}">
          <button data-more="uigf-import"><svg aria-hidden="true"><use href="#i-import"/></svg>导入 UIGF 记录</button>
          <button data-more="uigf-export" ${hasArchive ? "" : "disabled"}><svg aria-hidden="true"><use href="#i-export"/></svg>导出 UIGF 记录</button>
          <div class="menu-divider"></div>
          <button class="danger" data-more="remove" ${hasArchive ? "" : "disabled"}><svg aria-hidden="true"><use href="#i-delete"/></svg>删除当前存档</button>
        </div>
      </div>
    </div>`;

  if (!hasArchive || !stats) {
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

  content.innerHTML = `
    <div class="gacha-page">${toolbar}
      <div id="gacha-body" class="gacha-body"></div>
    </div>`;

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
      renderEventHistory(body, stats.event_history);
      break;
    case "avatar":
      renderNameCount(body, stats.avatars, "avatar");
      break;
    case "weapon":
      renderNameCount(body, stats.weapons, "weapon");
      break;
    case "countdown":
      void renderCountdown(body);
      break;
    default:
      body.innerHTML = "";
  }
}

function wireToolbar(content: HTMLElement): void {
  const select = content.querySelector<HTMLSelectElement>("#gacha-archive-select");
  select?.addEventListener("change", () => {
    console.info(`[gacha] 切换存档 → ${select.selectedOptions[0]?.textContent ?? select.value}`);
    selectedArchive = Number(select.value);
    void load().catch((e: unknown) => toast(errText(e), "error"));
  });

  // 刷新菜单与更多菜单：同一时刻只展开一个，点击外部全部收起
  const refreshBtn = content.querySelector<HTMLButtonElement>("#gacha-refresh-btn");
  const menu = content.querySelector<HTMLElement>("#gacha-refresh-menu");
  const moreBtn = content.querySelector<HTMLButtonElement>("#gacha-more-btn");
  const moreMenu = content.querySelector<HTMLElement>("#gacha-more-menu");
  const closeMenus = () => {
    menu?.classList.add("hidden");
    moreMenu?.classList.add("hidden");
    refreshMenuOpen = false;
    moreMenuOpen = false;
  };
  refreshBtn?.addEventListener("click", () => {
    refreshMenuOpen = menu?.classList.contains("hidden") ?? false;
    menu?.classList.toggle("hidden");
    moreMenu?.classList.add("hidden");
    moreMenuOpen = false;
  });
  moreBtn?.addEventListener("click", () => {
    moreMenuOpen = moreMenu?.classList.contains("hidden") ?? false;
    moreMenu?.classList.toggle("hidden");
    menu?.classList.add("hidden");
    refreshMenuOpen = false;
  });
  if (!outsideClickReady) {
    outsideClickReady = true;
    document.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".refresh-wrap")) return;
      document.getElementById("gacha-refresh-menu")?.classList.add("hidden");
      document.getElementById("gacha-more-menu")?.classList.add("hidden");
      refreshMenuOpen = false;
      moreMenuOpen = false;
    });
  }

  menu?.querySelectorAll<HTMLButtonElement>("[data-refresh]").forEach((btn) => {
    btn.addEventListener("click", () => {
      menu.classList.add("hidden");
      const kind = btn.dataset.refresh!;
      console.info(`[gacha] 用户选择刷新方式: ${kind}`);
      if (kind === "stoken") {
        void refreshByStoken();
      } else if (kind === "webcache") {
        void refreshByWebCache();
      } else {
        openManualDialog();
      }
    });
  });

  // ⋯ 更多菜单：UIGF 导入/导出、删除存档（胡桃的 SecondaryCommands）
  const currentUid = (): string => archives.find((a) => a.id === selectedArchive)?.uid ?? "";

  moreMenu?.querySelector<HTMLButtonElement>("[data-more='uigf-import']")?.addEventListener("click", () => {
    closeMenus();
    void importUigf(load);
  });

  moreMenu?.querySelector<HTMLButtonElement>("[data-more='uigf-export']")?.addEventListener("click", () => {
    closeMenus();
    if (selectedArchive === null) {
      return;
    }
    const uid = currentUid();
    void (async () => {
      const path = await api.uigfExport(uid);
      toast(`已导出到 ${path}`, "success");
    })().catch((e: unknown) => {
      if (isApiError(e) && e.code === -100) {
        return;
      }
      toast(`UIGF 导出失败: ${errText(e)}`, "error");
    });
  });

  moreMenu?.querySelector<HTMLButtonElement>("[data-more='remove']")?.addEventListener("click", () => {
    closeMenus();
    if (selectedArchive === null) {
      return;
    }
    const uid = currentUid();
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
// 总览统计卡
// ---------------------------------------------------------------------------

function renderOverview(body: HTMLElement): void {
  const s = stats!;
  const cards: WishSummary[] = [s.avatar_wish, s.weapon_wish, s.standard_wish];
  if (s.chronicled_wish.total_count > 0) cards.push(s.chronicled_wish);
  body.innerHTML = `<div class="stats-cards">${cards.map((w, index) => statsCard(w, index === 0)).join("")}</div>`;
  body.querySelectorAll<HTMLButtonElement>("[data-stats-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      statsViewMode.set(button.dataset.card!, button.dataset.statsMode as "stats" | "ratio");
      renderOverview(body);
    });
  });
  body.querySelector<HTMLButtonElement>(".combine-toggle")?.addEventListener("click", () => {
    combineAvatarOrange = !combineAvatarOrange;
    renderOverview(body);
  });
}

const statsViewMode = new Map<string, "stats" | "ratio">();

/** 五星出货列表：固定卡片高度内独立滚动。 */
function orangeListHtml(w: WishSummary, combined: boolean): string {
  const entries = (combined ? combineLimitedOrange(w.orange_list) : w.orange_list).slice().reverse(); // 最新在前
  if (entries.length === 0) {
    return `<div class="orange-scroll"><div class="orange-empty">暂无五星记录</div></div>`;
  }
  return `<div class="orange-scroll" role="region" aria-label="${esc(w.name)}五星记录" tabindex="0"><div class="orange-flat">${entries
    .map(
      (o) => `<div class="flat-tile" title="${esc(o.name)} · ${o.pull} 抽${combined && o.is_up ? "（含此前歪出的抽数）" : ""} · ${esc(o.time.slice(0, 10))}${w.has_up ? (o.is_up ? " · 命中UP" : " · 歪了") : ""}">
        <div class="tile-face orange">${esc(o.name.slice(0, 1))}<img src="${iconSrc(o.name)}" onerror="this.remove()" loading="lazy"/>${w.has_up ? `<span class="up-badge ${o.is_up ? "hit" : "lost"}">${o.is_up ? "UP" : "歪"}</span>` : ""}</div>
        <span class="flat-count orange">${o.pull}</span>
      </div>`,
    )
    .join("")}</div></div>`;
}

function statsCard(w: WishSummary, isAvatar: boolean): string {
  const orangePct = (w.orange_percent * 100).toFixed(1);
  const purplePct = (w.purple_percent * 100).toFixed(1);
  const bluePct = (w.blue_percent * 100).toFixed(1);
  const orangeBar = Math.min(100, (w.last_orange_pull / w.guarantee_orange_threshold) * 100);
  const purpleBar = Math.min(100, (w.last_purple_pull / w.guarantee_purple_threshold) * 100);
  const mode = statsViewMode.get(w.name) ?? "stats";

  return `
  <div class="stats-card">
    <div class="stats-title-row">
      <div class="stats-title">${esc(w.name)}</div>
      ${isAvatar ? `<button class="combine-toggle ${combineAvatarOrange ? "active" : ""}" type="button" title="${combineAvatarOrange ? "显示每个五星的抽数" : "合并显示限定金总抽数"}" aria-label="${combineAvatarOrange ? "显示每个五星的抽数" : "合并显示限定金总抽数"}" aria-pressed="${combineAvatarOrange}">★</button>` : ""}
      ${w.has_up ? `<span class="pity-state ${w.guaranteed ? "lost" : ""}" title="${w.guaranteed ? "最近一个五星是歪的，下一个五星必为 UP" : "下一个五星有 50% 概率为 UP"}">${w.guaranteed ? "大保底" : "小保底"}</span>` : ""}
    </div>
    <div class="stats-total"><span class="big">${w.total_count}</span> 抽</div>
    <div class="pity-grid">
      <div class="pity-meter orange"><span>距上个五星</span><b>${w.last_orange_pull}</b><div class="gauge"><div class="gauge-fill orange" style="width:${orangeBar}%"></div></div></div>
      <div class="pity-meter purple"><span>距上个四星</span><b>${w.last_purple_pull}</b><div class="gauge"><div class="gauge-fill purple" style="width:${purpleBar}%"></div></div></div>
    </div>
    <div class="stats-time">${esc(w.from_time.slice(0, 10))} — ${esc(w.to_time.slice(0, 10))}</div>
    <div class="stats-mode-switch" aria-label="统计显示方式">
      <button data-card="${esc(w.name)}" data-stats-mode="stats" class="${mode === "stats" ? "active" : ""}" aria-pressed="${mode === "stats"}">统计</button>
      <button data-card="${esc(w.name)}" data-stats-mode="ratio" class="${mode === "ratio" ? "active" : ""}" aria-pressed="${mode === "ratio"}">比例</button>
    </div>

    ${mode === "stats" ? `<div class="stats-avg">
      <div><span>五星平均抽数</span><b>${w.total_orange ? w.average_orange_pull.toFixed(2) : "—"} 抽</b></div>
      ${w.has_up ? `<div><span>UP 平均抽数</span><b>${w.total_up_orange ? w.average_up_orange_pull.toFixed(2) : "—"} 抽</b></div>` : ""}
      <div><span>最非</span><b>${w.total_orange ? w.max_orange_pull : "—"} 抽</b></div>
      <div><span>最欧</span><b>${w.total_orange ? w.min_orange_pull : "—"} 抽</b></div>
    </div>` : `<div class="stats-quality">
      <div class="q orange"><span class="q-name">五星</span><span class="q-count">${w.total_orange}</span><span class="q-pct">${orangePct}%</span></div>
      <div class="q purple"><span class="q-name">四星</span><span class="q-count">${w.total_purple}</span><span class="q-pct">${purplePct}%</span></div>
      <div class="q blue"><span class="q-name">三星</span><span class="q-count">${w.total_blue}</span><span class="q-pct">${bluePct}%</span></div>
      ${w.has_up ? `<div class="q"><span class="q-name">UP / 歪</span><span class="q-count">${w.total_up_orange} / ${w.total_lost_orange}</span><span class="q-pct">五星结果</span></div>` : ""}
    </div>`}

    ${orangeListHtml(w, isAvatar && combineAvatarOrange)}
  </div>`;
}

// ---------------------------------------------------------------------------
// 角色 / 武器（对应原版 Avatar/Weapon Pivot：按品质分卡片区 + 平铺网格）
// ---------------------------------------------------------------------------

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
      const q = rank === 5 ? "orange" : rank === 4 ? "purple" : "blue";

      const tiles = items
        .map(
          (e) => `<div class="flat-tile" title="${esc(e.name)} × ${e.count}">
            <div class="tile-face ${q}">${esc(e.name.slice(0, 1))}<img src="${iconSrc(e.name)}" onerror="this.remove()" loading="lazy"/></div>
            <span class="flat-count ${q}">${e.count}</span>
          </div>`,
        )
        .join("");

      return `
        <div class="section-card">
          <div class="section-header">
            <span class="section-title ${q}">${rankNames[rank]}</span>
            <span class="section-count">${items.length} 种</span>
          </div>
          <div class="section-body flat">${tiles}</div>
        </div>`;
    })
    .join("");

  body.innerHTML = sections;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
