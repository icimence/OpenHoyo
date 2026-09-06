// 周期挑战记录三页（对应原版 SpiralAbyssRecordPage / RoleCombatPage / HardChallengePage）：
// 左侧期号列表 + 右侧详情，风控拦截自动走安全验证（共享 verify.ts）。
import {
  api,
  errText,
  type AbyssFloor,
  type AbyssLevel,
  type HcScheduleData,
  type RankAvatar,
  type RoleCombatData,
  type SpiralAbyss,
  type StatAvatar,
  type TheaterAvatar,
  type UserDto,
} from "./api";
import { toast } from "./ui";
import { abandonActiveGeetest, fetchWithVerification, isRiskError } from "./verify";

// ---------------------------------------------------------------------------
// 共享工具
// ---------------------------------------------------------------------------

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** unix 秒 → "MM.dd HH:mm" */
function fmtTime(sec: number): string {
  if (sec <= 0) {
    return "-";
  }
  const d = new Date(sec * 1000);
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 秒数时长 → "X分Y秒" */
function fmtDuration(sec: number): string {
  if (sec <= 0) {
    return "-";
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

/** 大数值缩写：1234567 → 123.4w（对应原版 ValueFormatter） */
function fmtValue(v: number | string): string {
  const n = typeof v === "string" ? Number(v) || 0 : v;
  if (n >= 100000000) {
    return `${(n / 100000000).toFixed(2)}亿`;
  }
  if (n >= 10000) {
    return `${(n / 10000).toFixed(2)}万`;
  }
  return n.toLocaleString("zh-CN");
}

/** 角色头像方块：稀有度描边 + 可选角标（命座/试用/支援） */
function avatarTile(icon: string, rarity: number, opts: { badge?: string; badgeCls?: string; dim?: boolean; size?: number } = {}): string {
  const size = opts.size ?? 48;
  const cls = rarity >= 5 ? "r5" : rarity >= 4 ? "r4" : "r3";
  return `
  <div class="ch-avatar ${opts.dim ? "dim" : ""}" title="">
    <img class="${cls}" src="${esc(icon)}" style="width:${size}px;height:${size}px" loading="lazy" onerror="this.style.opacity=0.2"/>
    ${opts.badge ? `<span class="ch-badge ${opts.badgeCls ?? ""}">${esc(opts.badge)}</span>` : ""}
  </div>`;
}

function stars(count: number, max: number): string {
  let html = "";
  for (let i = 0; i < max; i++) {
    html += `<span class="ch-star ${i < count ? "on" : ""}">★</span>`;
  }
  return html;
}

/** 剧诗难度名（对应 ModelIntrinsicRoleCombatDifficultyLevel 本地化） */
const THEATER_DIFFICULTY: Record<number, string> = {
  1: "轻简模式",
  2: "普通模式",
  3: "困难模式",
  4: "卓越模式",
  5: "月谕模式",
};

/** 幽境危战难度名（对应 ModelIntrinsicHardChallengeDifficultyLevel 本地化） */
const HC_DIFFICULTY: Record<number, string> = {
  1: "普通",
  2: "进阶",
  3: "困难",
  4: "险恶",
  5: "绝境",
  6: "无畏",
};

const HC_BEST_TYPE: Record<number, string> = { 1: "最强一击", 2: "最高总伤害" };

// ---------------------------------------------------------------------------
// 页面外壳：头部 + 刷新 + 左侧期号列表 + 右侧详情
// ---------------------------------------------------------------------------

interface Shell {
  root: HTMLElement;
  list: HTMLElement;
  main: HTMLElement;
  refreshBtn: HTMLButtonElement;
}

function renderStatCard(label: string, value: string, icon?: string, rarity?: number): string {
  return `
  <div class="ch-stat">
    <span class="ch-stat-label">${esc(label)}</span>
    <span class="ch-stat-value">${esc(value)}${icon ? avatarTile(icon, rarity ?? 5, { size: 32 }).replace('title=""', "") : ""}</span>
  </div>`;
}

function pageShell(content: HTMLElement, title: string, subtitle: string, listHtml: string, rootId: string): Shell {
  content.innerHTML = `
    <div class="page-header"><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>
    <div class="dn-toolbar">
      <button class="primary" id="${rootId}-refresh"><svg><use href="#i-refresh"/></svg>刷新数据</button>
      <span class="dn-hint">数据来自米哈游游戏记录</span>
    </div>
    <div id="${rootId}" class="ch-shell">
      <div class="ch-entries">${listHtml}</div>
      <div class="ch-main"><div class="ch-empty">尚未刷新</div></div>
    </div>`;
  return {
    root: document.getElementById(rootId)!,
    list: content.querySelector(`#${rootId} .ch-entries`)!,
    main: content.querySelector(`#${rootId} .ch-main`)!,
    refreshBtn: document.getElementById(`${rootId}-refresh`) as HTMLButtonElement,
  };
}

/** 渲染期号列表项 */
function entryItem(title: string, caption: string, timeText: string, active: boolean): string {
  return `
  <button class="ch-entry ${active ? "active" : ""}">
    <div class="ch-entry-row"><span class="ch-entry-title">${esc(title)}</span><span class="ch-entry-side">${esc(caption)}</span></div>
    <div class="ch-entry-time">${esc(timeText)}</div>
  </button>`;
}

/** 单飞守卫（每页一份；页面重渲染时复位） */
let refreshing = false;

function resetGuards(): void {
  refreshing = false;
  abandonActiveGeetest();
}

// ---------------------------------------------------------------------------
// 深境螺旋
// ---------------------------------------------------------------------------

/** 全部历史期（持久化，期号倒序） */
let abyssPeriods: SpiralAbyss[] = [];
let abyssIdx = 0;
let abyssFloorIdx = 12;

/** @internal 仅供离线渲染测试注入数据（构建产物不含调用方） */
export const __testHooks = {
  setAbyss(list: SpiralAbyss[]): void {
    abyssPeriods = list;
  },
  setTheater(list: RoleCombatData[]): void {
    theaterPeriods = list;
  },
  setHc(list: HcScheduleData[]): void {
    hcPeriods = list;
  },
};

export function renderAbyssPage(content: HTMLElement, currentUser: UserDto | undefined): void {
  if (!currentUser || currentUser.game_roles.length === 0) {
    content.innerHTML = `<div class="page-header"><h2>深境螺旋</h2><p>每期挑战记录</p></div>
      <div class="placeholder-page"><div class="placeholder-card"><svg><use href="#i-unimplemented"/></svg>
      <div class="title">尚未登录</div><div class="desc">登录后可查看深境螺旋记录</div></div></div>`;
    return;
  }
  resetGuards();
  const role = currentUser.game_roles[0];
  const shell = pageShell(content, "深境螺旋", "每期挑战记录与统计（历史保存在本地）", "", "abyss-root");

  function renderList(): void {
    if (abyssPeriods.length === 0) {
      shell.list.innerHTML = '<div class="ch-entry-time" style="padding:8px">暂无数据</div>';
      return;
    }
    shell.list.innerHTML = abyssPeriods
      .map((d, i) =>
        entryItem(
          `第 ${d.schedule_id} 期${i === 0 ? " · 最新" : ""}`,
          d.is_unlock ? d.max_floor : "未挑战",
          `${fmtTime(d.start_time)} - ${fmtTime(d.end_time)}`,
          abyssIdx === i,
        ),
      )
      .join("");
    shell.list.querySelectorAll<HTMLButtonElement>(".ch-entry").forEach((btn, i) => {
      btn.addEventListener("click", () => {
        abyssIdx = i;
        renderList();
        renderDetail();
      });
    });
  }

  function renderFloorDetail(floor: AbyssFloor): string {
    const disorders = floor.ley_line_disorder ?? [];
    const disorderHtml = disorders.length
      ? `<div class="ch-disorders">${disorders.map((d) => `<div class="ch-disorder">${esc(d)}</div>`).join("")}</div>`
      : "";
    const levels = floor.levels
      .map((lv: AbyssLevel) => {
        const battles = lv.battles
          .map((b) => {
            const avs = b.avatars.map((a) => avatarTile(a.icon, a.rarity, { badge: `Lv.${a.level}`, badgeCls: "lv" })).join("");
            return `
            <div class="ch-battle">
              <div class="ch-battle-label">${b.index === 1 ? "上半" : "下半"} · ${fmtTime(b.timestamp)}</div>
              <div class="ch-avatar-row">${avs}</div>
            </div>`;
          })
          .join("");
        return `
        <div class="ch-level">
          <div class="ch-level-head">
            <span>第 ${lv.index} 间</span>
            <span class="ch-stars">${stars(lv.star, lv.max_star)}</span>
          </div>
          <div class="ch-battle-grid">${battles}</div>
        </div>`;
      })
      .join("");
    return `
    <div class="ch-card">
      <div class="ch-floor-head">
        <span class="ch-floor-title">第 ${floor.index} 层</span>
        <span class="ch-stars big">${stars(floor.star, floor.max_star)}</span>
        <span class="ch-floor-settle">${floor.settle_time > 0 ? `通关于 ${fmtTime(floor.settle_time)}` : "未挑战"}</span>
      </div>
      ${disorderHtml}
      ${levels}
    </div>`;
  }

  function renderDetail(): void {
    const data = abyssPeriods[abyssIdx];
    if (!data) {
      shell.main.innerHTML = '<div class="ch-empty">尚未刷新</div>';
      return;
    }
    if (!data.is_unlock || data.floors.length === 0) {
      shell.main.innerHTML = '<div class="ch-empty">本期限未挑战深境螺旋</div>';
      return;
    }

    const rankCard = (label: string, ranks: RankAvatar[]): string => {
      const top = ranks[0];
      if (!top) {
        return renderStatCard(label, "-");
      }
      return renderStatCard(label, fmtValue(top.value), top.avatar_icon, top.rarity);
    };

    const floors = data.floors.filter((f) => f.index >= 9).sort((a, b) => b.index - a.index);
    if (!floors.some((f) => f.index === abyssFloorIdx)) {
      abyssFloorIdx = floors[0]?.index ?? 12;
    }
    const floorTabs = floors
      .map((f) => `<button class="ch-tab ${f.index === abyssFloorIdx ? "active" : ""}" data-floor="${f.index}">第${f.index}层</button>`)
      .join("");
    const floor = floors.find((f) => f.index === abyssFloorIdx)!;

    shell.main.innerHTML = `
      <div class="ch-stats-grid">
        ${renderStatCard("最多到达", data.max_floor)}
        ${renderStatCard("战斗次数", String(data.total_battle_times))}
        ${renderStatCard("总星数", `${data.total_star}/36`)}
        ${rankCard("最多击破", data.defeat_rank)}
        ${rankCard("最高伤害", data.damage_rank)}
        ${rankCard("最高承伤", data.take_damage_rank)}
        ${rankCard("元素战技", data.energy_skill_rank)}
        ${rankCard("普通攻击", data.normal_skill_rank)}
      </div>
      <div class="ch-reveal">
        <div class="ch-section-title">出场角色</div>
        <div class="ch-avatar-row wrap">
          ${data.reveal_rank.map((r) => avatarTile(r.avatar_icon, r.rarity, { badge: fmtValue(r.value) })).join("")}
        </div>
      </div>
      <div class="ch-tabs">${floorTabs}</div>
      ${renderFloorDetail(floor)}`;

    shell.main.querySelectorAll<HTMLButtonElement>(".ch-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        abyssFloorIdx = Number(btn.dataset.floor);
        renderDetail();
      });
    });
  }

  async function refresh(): Promise<void> {
    if (refreshing) {
      return;
    }
    refreshing = true;
    shell.refreshBtn.disabled = true;
    console.info("[chronicle] 深境螺旋刷新");
    try {
      abyssPeriods = await fetchWithVerification(currentUser!.id, (ch) =>
        api.chronicleRefresh<SpiralAbyss>(currentUser!.id, role.game_uid, "abyss", ch),
      );
      console.info(`[chronicle] 深境螺旋刷新完成，共 ${abyssPeriods.length} 期`);
      abyssIdx = 0;
      renderList();
      renderDetail();
    } catch (e) {
      if (!isRiskError(e)) {
        console.warn(`[chronicle] 深境螺旋刷新失败: ${errText(e)}`);
        toast(`深境螺旋刷新失败: ${errText(e)}`, "error");
      }
    } finally {
      refreshing = false;
      shell.refreshBtn.disabled = false;
    }
  }

  shell.refreshBtn.addEventListener("click", () => {
    void refresh();
  });
  // 先秒读本地历史，再后台拉新合并
  renderList();
  renderDetail();
  void api
    .chronicleList<SpiralAbyss>(currentUser.id, role.game_uid, "abyss")
    .then((list) => {
      if (abyssPeriods.length === 0 && list.length > 0) {
        abyssPeriods = list;
        renderList();
        renderDetail();
      }
    })
    .catch(() => undefined);
  void refresh();
}

// ---------------------------------------------------------------------------
// 幻想真境剧诗
// ---------------------------------------------------------------------------

/** 全部历史期（持久化，期号倒序） */
let theaterPeriods: RoleCombatData[] = [];
let theaterIdx = 0;

export function renderTheaterPage(content: HTMLElement, currentUser: UserDto | undefined): void {
  if (!currentUser || currentUser.game_roles.length === 0) {
    content.innerHTML = `<div class="page-header"><h2>幻想真境剧诗</h2><p>每期挑战记录</p></div>
      <div class="placeholder-page"><div class="placeholder-card"><svg><use href="#i-unimplemented"/></svg>
      <div class="title">尚未登录</div><div class="desc">登录后可查看幻想真境剧诗记录</div></div></div>`;
    return;
  }
  resetGuards();
  const role = currentUser.game_roles[0];
  const shell = pageShell(content, "幻想真境剧诗", "每期挑战记录与统计", "", "theater-root");

  function renderList(): void {
    const entries = theaterPeriods;
    if (entries.length === 0) {
      shell.list.innerHTML = '<div class="ch-entry-time" style="padding:8px">暂无数据</div>';
      return;
    }
    shell.list.innerHTML = entries
      .map((d, i) =>
        entryItem(
          `第 ${d.schedule.schedule_id} 期`,
          d.has_data ? `${d.stat.max_round_id}幕` : "未挑战",
          `${fmtTime(d.schedule.start_time)} - ${fmtTime(d.schedule.end_time)}`,
          theaterIdx === i,
        ),
      )
      .join("");
    shell.list.querySelectorAll<HTMLButtonElement>(".ch-entry").forEach((btn, i) => {
      btn.addEventListener("click", () => {
        theaterIdx = i;
        renderList();
        renderDetail();
      });
    });
  }

  function statAvatarCard(label: string, a: StatAvatar | null): string {
    if (!a || !a.value) {
      return renderStatCard(label, "-");
    }
    return renderStatCard(label, fmtValue(a.value), a.avatar_icon, a.rarity);
  }

  function renderDetail(): void {
    const entry: RoleCombatData | undefined = theaterPeriods[theaterIdx];
    if (!entry) {
      shell.main.innerHTML = '<div class="ch-empty">尚未刷新</div>';
      return;
    }
    if (!entry.has_data) {
      shell.main.innerHTML = '<div class="ch-empty">本期限未参加幻想真境剧诗</div>';
      return;
    }
    try {
    const stat = entry.stat;
    const fs = entry.detail.fight_statistics;

    const rounds = [...entry.detail.rounds_data]
      .sort((a, b) => a.round_id - b.round_id)
      .map((r) => {
        const avs = r.avatars
          .map((a: TheaterAvatar) =>
            avatarTile(a.image, a.rarity, {
              badge: a.avatar_type === 2 ? "试用" : a.avatar_type === 3 ? "支援" : `Lv.${a.level}`,
              badgeCls: a.avatar_type === 1 ? "lv" : "trial",
            }),
          )
          .join("");
        const enemies = r.enemies.map((e) => avatarTile(e.icon, 3, { badge: `Lv.${e.level}`, badgeCls: "lv", size: 40 })).join("");
        const splendour = r.splendour_buff;
        const splendourName = splendour?.summary?.name?.trim();
        const splendourHtml = splendour
          ? `
          <div class="ch-round-col">
            <div class="ch-section-title small">辉彩祝福${splendourName ? ` · ${esc(splendourName)}` : ""}</div>
            <div class="ch-avatar-row wrap">
              ${splendour.buffs.map((b) => avatarTile(b.icon, 4, { badge: `Lv.${b.level}`, badgeCls: "lv", size: 40 })).join("")}
            </div>
          </div>`
          : "";
        const choiceHtml = r.choice_cards.length
          ? `
          <div class="ch-round-col">
            <div class="ch-section-title small">神秘收获</div>
            <div class="ch-avatar-row wrap">${r.choice_cards.map((b) => avatarTile(b.icon, 4, { size: 40 })).join("")}</div>
          </div>`
          : "";
        return `
        <div class="ch-card ch-round">
          <div class="ch-round-head">
            <span class="ch-medal ${r.is_get_medal ? "on" : ""}">★</span>
            <span class="ch-round-title">第 ${r.round_id} 幕</span>
            <span class="ch-round-time">${fmtTime(r.finish_time)}</span>
          </div>
          <div class="ch-round-grid">
            <div class="ch-round-col"><div class="ch-section-title small">敌人</div><div class="ch-avatar-row wrap">${enemies}</div></div>
            <div class="ch-round-col"><div class="ch-section-title small">出战角色</div><div class="ch-avatar-row wrap">${avs}</div></div>
          </div>
          ${splendourHtml || choiceHtml ? `<div class="ch-round-grid">${splendourHtml}${choiceHtml}</div>` : ""}
        </div>`;
      })
      .join("");

    const backups = entry.detail.backup_avatars
      .map((a) => avatarTile(a.image, a.rarity, { badge: `Lv.${a.level}`, badgeCls: "lv" }))
      .join("");

    shell.main.innerHTML = `
      <div class="ch-stats-grid">
        ${renderStatCard("挑战难度", THEATER_DIFFICULTY[stat.difficulty_id] ?? `难度${stat.difficulty_id}`)}
        ${renderStatCard("通关幕数", `${stat.max_round_id} 幕`)}
        ${renderStatCard("获得勋章", String(stat.medal_num))}
        ${renderStatCard("幻剧币", String(stat.coin_num))}
        ${renderStatCard("助演次数", String(stat.rent_cnt))}
        ${renderStatCard("总用时", fmtDuration(fs.total_use_time))}
        ${statAvatarCard("最多击破", fs.max_defeat_avatar)}
        ${statAvatarCard("最高伤害", fs.max_damage_avatar)}
        ${statAvatarCard("最高承伤", fs.max_take_damage_avatar)}
      </div>
      ${backups ? `<div class="ch-reveal"><div class="ch-section-title">候补角色</div><div class="ch-avatar-row wrap">${backups}</div></div>` : ""}
      <div class="ch-reveal"><div class="ch-section-title">挑战记录</div></div>
      ${rounds}`;
    } catch (err) {
      shell.main.innerHTML = `<div class="ch-empty">详情渲染失败: ${esc(String(err))}</div>`;
    }
  }

  async function refresh(): Promise<void> {
    if (refreshing) {
      return;
    }
    refreshing = true;
    shell.refreshBtn.disabled = true;
    try {
      theaterPeriods = await fetchWithVerification(currentUser!.id, (ch) =>
        api.chronicleRefresh<RoleCombatData>(currentUser!.id, role.game_uid, "theater", ch),
      );
      // 默认选中最近一个有数据的期
      const idx = theaterPeriods.findIndex((d) => d.has_data);
      theaterIdx = idx >= 0 ? idx : 0;
      renderList();
      renderDetail();
    } catch (e) {
      if (!isRiskError(e)) {
        toast(`幻想真境剧诗刷新失败: ${errText(e)}`, "error");
      }
    } finally {
      refreshing = false;
      shell.refreshBtn.disabled = false;
    }
  }

  shell.refreshBtn.addEventListener("click", () => {
    void refresh();
  });
  // 先秒读本地历史，再后台拉新合并
  renderList();
  renderDetail();
  void api
    .chronicleList<RoleCombatData>(currentUser.id, role.game_uid, "theater")
    .then((list) => {
      if (theaterPeriods.length === 0 && list.length > 0) {
        theaterPeriods = list;
        theaterIdx = list.findIndex((d) => d.has_data);
        if (theaterIdx < 0) {
          theaterIdx = 0;
        }
        renderList();
        renderDetail();
      }
    })
    .catch(() => undefined);
  void refresh();
}

// ---------------------------------------------------------------------------
// 幽境危战
// ---------------------------------------------------------------------------

/** 全部历史期（持久化，期号倒序） */
let hcPeriods: HcScheduleData[] = [];
let hcIdx = 0;
let hcMode = "single";

export function renderHardChallengePage(content: HTMLElement, currentUser: UserDto | undefined): void {
  if (!currentUser || currentUser.game_roles.length === 0) {
    content.innerHTML = `<div class="page-header"><h2>幽境危战</h2><p>每期挑战记录</p></div>
      <div class="placeholder-page"><div class="placeholder-card"><svg><use href="#i-unimplemented"/></svg>
      <div class="title">尚未登录</div><div class="desc">登录后可查看幽境危战记录</div></div></div>`;
    return;
  }
  resetGuards();
  const role = currentUser.game_roles[0];
  const shell = pageShell(content, "幽境危战", "每期挑战记录与统计", "", "hc-root");

  function renderList(): void {
    const entries = hcPeriods;
    if (entries.length === 0) {
      shell.list.innerHTML = '<div class="ch-entry-time" style="padding:8px">暂无数据</div>';
      return;
    }
    shell.list.innerHTML = entries
      .map((d, i) =>
        entryItem(
          d.schedule.name || `第 ${d.schedule.schedule_id} 期`,
          d.single.has_data || d.mp.has_data ? "有记录" : "未挑战",
          `${fmtTime(d.schedule.start_time)} - ${fmtTime(d.schedule.end_time)}`,
          hcIdx === i,
        ),
      )
      .join("");
    shell.list.querySelectorAll<HTMLButtonElement>(".ch-entry").forEach((btn, i) => {
      btn.addEventListener("click", () => {
        hcIdx = i;
        renderList();
        renderDetail();
      });
    });
  }

  function renderDetail(): void {
    const entry: HcScheduleData | undefined = hcPeriods[hcIdx];
    if (!entry) {
      shell.main.innerHTML = '<div class="ch-empty">尚未刷新</div>';
      return;
    }

    const blings = entry.blings
      .map((b) => avatarTile(b.image, b.rarity, { dim: !b.is_plus, badge: b.is_plus ? "✦" : undefined, badgeCls: "plus", size: 44 }))
      .join("");

    const cur = hcMode === "single" ? entry.single : entry.mp;
    const best = cur.best;
    const challenges = cur.challenge
      .map((c) => {
        const team = c.teams
          .map((a) => avatarTile(a.image, a.rarity, { badge: a.rank > 0 ? `${a.rank}命` : `Lv.${a.level}`, badgeCls: a.rank > 0 ? "plus" : "lv" }))
          .join("");
        const bests = c.best_avatar
          .map(
            (b) => `
          <div class="ch-hc-best">
            <img src="${esc(b.side_icon)}" loading="lazy" onerror="this.style.opacity=0.2"/>
            <span class="type">${HC_BEST_TYPE[b.kind] ?? ""}</span>
            <span class="value">${fmtValue(b.dps)}</span>
          </div>`,
          )
          .join("");
        const tags = c.monster.tags.map((t) => `<span class="ch-tag">${esc(t.description)}</span>`).join("");
        return `
        <div class="ch-card ch-hc-challenge">
          <div class="ch-hc-head">
            <img class="ch-hc-monster" src="${esc(c.monster.icon)}" loading="lazy" onerror="this.style.opacity=0.2" title="${esc(c.monster.desc.join("\n"))}"/>
            <div class="ch-hc-mtext">
              <div class="name">${esc(c.monster.name)}</div>
              <div class="level">Lv.${c.monster.level}</div>
            </div>
            <div class="ch-hc-time">${fmtDuration(c.second)}</div>
          </div>
          ${tags ? `<div class="ch-hc-tags">${tags}</div>` : ""}
          <div class="ch-avatar-row wrap">${team}</div>
          ${bests ? `<div class="ch-hc-bests">${bests}</div>` : ""}
        </div>`;
      })
      .join("");

    shell.main.innerHTML = `
      ${blings ? `<div class="ch-reveal"><div class="ch-section-title">闪耀榜角色（✦ 为上榜）</div><div class="ch-avatar-row wrap">${blings}</div></div>` : ""}
      <div class="ch-tabs">
        <button class="ch-tab ${hcMode === "single" ? "active" : ""}" data-mode="single">单人</button>
        <button class="ch-tab ${hcMode === "mp" ? "active" : ""}" data-mode="mp">多人</button>
      </div>
      ${
        !cur.has_data
          ? '<div class="ch-empty">本期限未挑战</div>'
          : `
        ${best ? `<div class="ch-stats-grid">${renderStatCard("最高难度", HC_DIFFICULTY[best.difficulty] ?? `难度${best.difficulty}`)}${renderStatCard("最短用时", fmtDuration(best.seconds))}</div>` : ""}
        <div class="ch-hc-grid">${challenges}</div>`
      }`;

    shell.main.querySelectorAll<HTMLButtonElement>(".ch-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        hcMode = btn.dataset.mode!;
        renderDetail();
      });
    });
  }

  async function refresh(): Promise<void> {
    if (refreshing) {
      return;
    }
    refreshing = true;
    shell.refreshBtn.disabled = true;
    try {
      hcPeriods = await fetchWithVerification(currentUser!.id, (ch) =>
        api.chronicleRefresh<HcScheduleData>(currentUser!.id, role.game_uid, "hard", ch),
      );
      const idx = hcPeriods.findIndex((d) => d.single.has_data || d.mp.has_data);
      hcIdx = idx >= 0 ? idx : 0;
      renderList();
      renderDetail();
    } catch (e) {
      if (!isRiskError(e)) {
        toast(`幽境危战刷新失败: ${errText(e)}`, "error");
      }
    } finally {
      refreshing = false;
      shell.refreshBtn.disabled = false;
    }
  }

  shell.refreshBtn.addEventListener("click", () => {
    void refresh();
  });
  // 先秒读本地历史，再后台拉新合并
  renderList();
  renderDetail();
  void api
    .chronicleList<HcScheduleData>(currentUser.id, role.game_uid, "hard")
    .then((list) => {
      if (hcPeriods.length === 0 && list.length > 0) {
        hcPeriods = list;
        hcIdx = list.findIndex((d) => d.single.has_data || d.mp.has_data);
        if (hcIdx < 0) {
          hcIdx = 0;
        }
        renderList();
        renderDetail();
      }
    })
    .catch(() => undefined);
  void refresh();
}
