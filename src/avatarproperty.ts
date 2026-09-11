// 我的角色（1:1 复刻原版 AvatarPropertyPage：卡片墙/列表详情双布局、排序、筛选、导出）
// 数据：index + character/list + character/detail 三接口前端组装；
// 图标：index 原生 URL 优先，名字型 icon（UI_XXX）走 enka 镜像。
import "./avatarproperty.css";
import { api, type AvatarPropertyDto, type DetailedCharacter, type IndexAvatar, type Reliquary, type UserDto } from "./api";
import { fetchWithVerification, isRiskError } from "./verify";
import { toast } from "./ui";

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// 常量映射（FightProperty / 元素 / 武器类型，对应原版 Model.Intrinsic）
// ---------------------------------------------------------------------------

const FIGHT_PROP_NAMES: Record<number, string> = {
  2: "生命值", 3: "生命值", 5: "攻击力", 6: "攻击力", 8: "防御力", 9: "防御力",
  20: "暴击率", 22: "暴击伤害", 23: "元素充能效率", 26: "治疗加成", 28: "元素精通",
  30: "物理伤害加成", 40: "火元素伤害加成", 41: "雷元素伤害加成", 42: "水元素伤害加成",
  43: "草元素伤害加成", 44: "风元素伤害加成", 45: "岩元素伤害加成", 46: "冰元素伤害加成",
  2000: "最大生命值", 2001: "当前攻击力", 2002: "当前防御力",
  3002: "暴击率", 3004: "暴击伤害", 3005: "元素充能效率", 3008: "元素精通",
};

/** 百分比展示的词条 */
const PERCENT_PROPS = new Set([3, 6, 9, 20, 22, 23, 26, 30, 40, 41, 42, 43, 44, 45, 46, 3002, 3004, 3005]);

const ELEMENTS: { key: string; label: string; color: string }[] = [
  { key: "Pyro", label: "火", color: "#ef7938" },
  { key: "Hydro", label: "水", color: "#4cc2f1" },
  { key: "Anemo", label: "风", color: "#73daca" },
  { key: "Electro", label: "雷", color: "#af8ec1" },
  { key: "Dendro", label: "草", color: "#a5c83b" },
  { key: "Cryo", label: "冰", color: "#9fd6e3" },
  { key: "Geo", label: "岩", color: "#ffb628" },
];

/** 武器类型（对应原版 WeaponType 枚举数值） */
const WEAPON_TYPES: { key: number; label: string }[] = [
  { key: 1, label: "单手剑" },
  { key: 10, label: "法器" },
  { key: 11, label: "双手剑" },
  { key: 12, label: "弓" },
  { key: 13, label: "长柄武器" },
];

/** 等级 → 突破阶段（角色突破星；武器 API 直接给 promote_level） */
function promoteOfLevel(level: string | number): number {
  const lv = typeof level === "number" ? level : Number.parseInt(String(level), 10) || 0;
  if (lv > 80) return 6;
  if (lv > 70) return 5;
  if (lv > 60) return 4;
  if (lv > 50) return 3;
  if (lv > 40) return 2;
  if (lv > 20) return 1;
  return 0;
}

/** UI_XXX 名字型图标 → enka 镜像；http 开头原样返回 */
function iconUrl(icon?: string): string {
  if (!icon) {
    return "";
  }
  return icon.startsWith("http") ? icon : `https://enka.network/ui/${icon}.png`;
}

function propValue(type: number, val: string): string {
  const n = Number.parseFloat(val) || 0;
  if (PERCENT_PROPS.has(type)) {
    return `${n.toFixed(1)}%`;
  }
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

// ---------------------------------------------------------------------------
// 视图模型（对应原版 AvatarView：三接口按 id 合并）
// ---------------------------------------------------------------------------

interface AvatarView {
  id: number;
  name: string;
  element: string;
  elementLabel: string;
  weaponType: number;
  weaponTypeLabel: string;
  quality: number;
  level: number;
  fetter: number;
  constellationCount: number;
  promoteArray: boolean[];
  icon: string;
  sideIcon: string;
  nameCard: string;
  weapon: { icon: string; name: string; quality: number; level: number; affix: number; promote: number };
  skills: { name: string; icon: string; level: number }[];
  constellations: { icon: string; effect: string; name: string; activated: boolean }[];
  properties: { type: number; name: string; value: string; add: string }[];
  reliquaries: Reliquary[];
  // 排序用属性值
  maxHp: number;
  curAtk: number;
  curDef: number;
  em: number;
}

/** 战斗天赋按 API 顺序：普攻/元素战技/元素爆发 */
const SKILL_LABELS: Record<number, string> = { 1: "A", 2: "E", 3: "Q" };

function buildAvatarViews(dto: AvatarPropertyDto): AvatarView[] {
  const indexById = new Map<number, IndexAvatar>();
  for (const a of dto.index?.avatars ?? []) {
    indexById.set(a.id, a);
  }
  const detailById = new Map<number, DetailedCharacter>();
  for (const d of dto.detail?.list ?? []) {
    detailById.set(d.base.id, d);
  }

  return (dto.list?.list ?? []).map((c): AvatarView => {
    const idx = indexById.get(c.id);
    const detail = detailById.get(c.id);
    const lv = typeof c.level === "number" ? c.level : Number.parseInt(c.level, 10) || 0;
    const promote = promoteOfLevel(c.level);
    const element = ELEMENTS.find((e) => e.key === (c.element ?? idx?.element));
    const wt = WEAPON_TYPES.find((w) => w.key === (c.weapon?.type ?? 0));

    const selected = new Map<number, number>();
    for (const p of detail?.selected_properties ?? []) {
      selected.set(p.property_type, Number.parseFloat(p.val) || 0);
    }
    const base = new Map<number, number>();
    for (const p of detail?.base_properties ?? []) {
      base.set(p.property_type, Number.parseFloat(p.val) || 0);
    }
    const properties = (detail?.selected_properties ?? []).map((p) => {
      const name = FIGHT_PROP_NAMES[p.property_type] ?? `属性${p.property_type}`;
      const total = Number.parseFloat(p.val) || 0;
      const baseVal = base.get(p.property_type);
      // 绿字加值：总值 - 基础值（面板 2000 系才有意义）
      const add = baseVal !== undefined && total > baseVal ? total - baseVal : 0;
      return {
        type: p.property_type,
        name,
        value: propValue(p.property_type, p.val),
        add: add > 0 ? `+${propValue(p.property_type, String(add))}` : "",
      };
    });

    return {
      id: c.id,
      name: c.name,
      element: c.element ?? idx?.element ?? "",
      elementLabel: element?.label ?? "?",
      weaponType: c.weapon?.type ?? 0,
      weaponTypeLabel: wt?.label ?? "?",
      quality: c.rarity,
      level: lv,
      fetter: c.fetter,
      constellationCount: c.actived_constellation_num,
      promoteArray: Array.from({ length: 6 }, (_, i) => i < promote),
      icon: iconUrl(c.image ?? idx?.image ?? c.icon ?? ""),
      sideIcon: iconUrl(idx?.side_icon),
      nameCard: idx?.card_image ?? "",
      weapon: {
        icon: iconUrl(detail?.weapon?.icon ?? c.weapon?.icon),
        name: detail?.weapon?.name ?? c.weapon?.name ?? "",
        quality: detail?.weapon?.rarity ?? c.weapon?.rarity ?? 5,
        level: typeof (detail?.weapon?.level ?? c.weapon?.level) === "number" ? (detail?.weapon?.level ?? c.weapon?.level ?? 0) : Number.parseInt(String(detail?.weapon?.level ?? c.weapon?.level ?? "0"), 10) || 0,
        affix: detail?.weapon?.affix_level ?? c.weapon?.affix_level ?? 0,
        promote: detail?.weapon?.promote_level ?? promoteOfLevel(String(detail?.weapon?.level ?? c.weapon?.level ?? 0)),
      },
      skills: (detail?.skills ?? []).filter((s) => s.skill_type === 1).map((s) => ({ name: s.name, icon: s.icon, level: s.level })),
      constellations: (detail?.constellations ?? []).map((k) => ({
        icon: iconUrl(k.icon),
        effect: k.effect,
        name: k.name,
        activated: k.is_actived,
      })),
      properties,
      reliquaries: [...(detail?.relics ?? [])].sort((a, b) => a.pos - b.pos),
      maxHp: selected.get(2000) ?? 0,
      curAtk: selected.get(2001) ?? 0,
      curDef: selected.get(2002) ?? 0,
      em: selected.get(28) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

type SortKind = "default" | "level" | "quality" | "constellation" | "fetter" | "hp" | "atk" | "def" | "em";

const SORTS: { key: SortKind; label: string }[] = [
  { key: "default", label: "默认" },
  { key: "level", label: "等级" },
  { key: "quality", label: "品质" },
  { key: "constellation", label: "命座" },
  { key: "fetter", label: "好感" },
  { key: "hp", label: "生命值" },
  { key: "atk", label: "攻击力" },
  { key: "def", label: "防御力" },
  { key: "em", label: "元素精通" },
];

let views: AvatarView[] = [];
let currentIdx = -1;
let layout: "grid" | "list" = "grid";
let sortKind: SortKind = "default";
const filterElements = new Set<string>();
const filterWeapons = new Set<number>();
let refreshing = false;
/** 当前渲染页面对应的用户（refresh 复用） */
let currentUserRef: UserDto | undefined;
/** 缓存/刷新的上次更新时间（unix 毫秒） */
let lastUpdated = 0;

function syncUpdatedLabel(): void {
  const el = document.getElementById("ap-updated");
  if (el) {
    el.textContent = lastUpdated > 0 ? `上次更新 ${new Date(lastUpdated).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "";
  }
}

export function renderAvatarPropertyPage(content: HTMLElement, user: UserDto | undefined): void {
  if (!user || user.game_roles.length === 0) {
    content.innerHTML = `<div class="page-header"><h2>我的角色</h2><p>角色练度总览</p></div>
      <div class="placeholder-page"><div class="placeholder-card"><svg><use href="#i-unimplemented"/></svg>
      <div class="title">尚未登录</div><div class="desc">登录后可查看角色练度</div></div></div>`;
    return;
  }
  const role = user.game_roles[0];
  currentUserRef = user;

  content.innerHTML = `
    <div class="page-header"><h2>我的角色</h2><p>角色练度总览（数据来自米游社游戏记录）</p></div>
    <div class="ap-shell" id="ap-root">
      <div class="ap-empty" id="ap-empty">
        <div class="ap-empty-card">
          <div class="ap-empty-emoji">📮</div>
          <div class="ap-empty-title">还没有角色数据</div>
          <button class="primary" id="ap-empty-refresh"><svg><use href="#i-refresh"/></svg>从米游社刷新</button>
        </div>
      </div>
      <div class="ap-main hidden" id="ap-main">
        <div class="ap-toolbar">
          <div class="ap-toolbar-left">
            <button class="ap-layout-btn active" id="ap-layout-grid" title="网格视图"><svg><use href="#i-setting"/></svg></button>
            <button class="ap-layout-btn" id="ap-layout-list" title="列表视图"><svg><use href="#i-gacha"/></svg></button>
            <select id="ap-sort" class="ap-sort">${SORTS.map((s) => `<option value="${s.key}">${s.label}</option>`).join("")}</select>
            <button id="ap-export" class="ap-export" title="导出练度统计到剪贴板">导出文本</button>
          </div>
          <div class="ap-filters" id="ap-filters">
            ${ELEMENTS.map((e) => `<button class="ap-filter-chip" data-element="${e.key}" title="${e.label}元素"><span class="dot" style="background:${e.color}"></span>${e.label}</button>`).join("")}
            <span class="ap-filter-sep"></span>
            ${WEAPON_TYPES.map((w) => `<button class="ap-filter-chip" data-weapon="${w.key}">${w.label}</button>`).join("")}
          </div>
          <span class="ap-updated" id="ap-updated"></span>
          <button class="primary" id="ap-refresh"><svg><use href="#i-refresh"/></svg>刷新数据</button>
        </div>
        <div class="ap-body" id="ap-body"></div>
      </div>
    </div>`;

  document.getElementById("ap-empty-refresh")?.addEventListener("click", () => void refresh(role.game_uid));
  document.getElementById("ap-refresh")?.addEventListener("click", () => void refresh(role.game_uid));
  document.getElementById("ap-layout-grid")?.addEventListener("click", () => {
    layout = "grid";
    syncLayoutBtns();
    renderBody();
  });
  document.getElementById("ap-layout-list")?.addEventListener("click", () => {
    layout = "list";
    syncLayoutBtns();
    renderBody();
  });
  document.getElementById("ap-sort")?.addEventListener("change", (ev) => {
    sortKind = (ev.target as HTMLSelectElement).value as SortKind;
    renderBody();
  });
  document.getElementById("ap-export")?.addEventListener("click", exportToText);
  document.querySelectorAll<HTMLButtonElement>("#ap-filters .ap-filter-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.element) {
        filterElements.has(btn.dataset.element) ? filterElements.delete(btn.dataset.element) : filterElements.add(btn.dataset.element);
      } else if (btn.dataset.weapon) {
        const wk = Number(btn.dataset.weapon);
        filterWeapons.has(wk) ? filterWeapons.delete(wk) : filterWeapons.add(wk);
      }
      btn.classList.toggle("active");
      renderBody();
    });
  });

  // 先读本地缓存秒显（不触网；与原版一致：进入显示缓存，手动点刷新更新）
  if (views.length === 0) {
    void (async () => {
      try {
        const cached = await api.avatarPropertyCache(user.id, role.game_uid);
        if (cached && views.length === 0) {
          views = buildAvatarViews(cached.data);
          currentIdx = views.length > 0 ? 0 : -1;
          lastUpdated = cached.updated_at;
          document.getElementById("ap-empty")?.classList.add("hidden");
          document.getElementById("ap-main")?.classList.remove("hidden");
          syncLayoutBtns();
          renderBody();
          syncUpdatedLabel();
          console.info(`[avatar_property] 已加载本地缓存（${views.length} 个角色）`);
        }
      } catch (e) {
        console.warn(`[avatar_property] 缓存读取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  // 已有数据直接渲染（切页不重拉）
  if (views.length > 0) {
    document.getElementById("ap-empty")?.classList.add("hidden");
    document.getElementById("ap-main")?.classList.remove("hidden");
    syncLayoutBtns();
    renderBody();
  }
}

function syncLayoutBtns(): void {
  document.getElementById("ap-layout-grid")?.classList.toggle("active", layout === "grid");
  document.getElementById("ap-layout-list")?.classList.toggle("active", layout === "list");
}

async function refresh(gameUid: string): Promise<void> {
  if (refreshing) {
    return;
  }
  refreshing = true;
  const user = currentUserRef;
  if (!user) {
    refreshing = false;
    return;
  }
  const btn = document.getElementById("ap-refresh") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
  }
  console.info("[avatar_property] 刷新数据…");
  try {
    const dto = await fetchWithVerification(user.id, (ch) => api.avatarPropertyRefresh(user.id, gameUid, ch));
    views = buildAvatarViews(dto);
    currentIdx = views.length > 0 ? 0 : -1;
    document.getElementById("ap-empty")?.classList.add("hidden");
    document.getElementById("ap-main")?.classList.remove("hidden");
    syncLayoutBtns();
    renderBody();
    console.info(`[avatar_property] 刷新完成（${views.length} 个角色）`);
    lastUpdated = Date.now();
    syncUpdatedLabel();
    toast(`已刷新 ${views.length} 个角色`, "success");
  } catch (e) {
    if (!isRiskError(e)) {
      toast(`刷新失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  } finally {
    refreshing = false;
    if (btn) {
      btn.disabled = false;
    }
  }
}

function sortedFiltered(): AvatarView[] {
  let out = [...views];
  if (filterElements.size > 0) {
    out = out.filter((v) => filterElements.has(v.element));
  }
  if (filterWeapons.size > 0) {
    out = out.filter((v) => filterWeapons.has(v.weaponType));
  }
  const key = (v: AvatarView): number => {
    switch (sortKind) {
      case "level": return v.level;
      case "quality": return v.quality;
      case "constellation": return v.constellationCount;
      case "fetter": return v.fetter;
      case "hp": return v.maxHp;
      case "atk": return v.curAtk;
      case "def": return v.curDef;
      case "em": return v.em;
      default: return 0;
    }
  };
  if (sortKind !== "default") {
    out.sort((a, b) => key(b) - key(a));
  }
  return out;
}

function renderBody(): void {
  const body = document.getElementById("ap-body");
  if (!body) {
    return;
  }
  const list = sortedFiltered();
  // 当前选中角色可能被筛掉，回退到第一个
  if (!list.some((v) => v === views[currentIdx])) {
    currentIdx = views.indexOf(list[0] ?? views[0]);
  }
  body.innerHTML = layout === "grid" ? renderGrid(list) : renderListDetail(list);
  bindBodyEvents(body);
}

// ---------------------------------------------------------------------------
// 网格视图（对应原版 AvatarGridViewTemplate：名片背景 + 头像/武器/技能三列）
// ---------------------------------------------------------------------------

function starIcons(promote: boolean[]): string {
  return promote.map((on) => `<span class="ap-star ${on ? "on" : ""}">★</span>`).join("");
}

function renderGrid(list: AvatarView[]): string {
  return `<div class="ap-grid">${list
    .map((v) => {
      const cur = v === views[currentIdx];
      return `
      <button class="ap-card ${cur ? "active" : ""}" data-id="${v.id}">
        ${v.nameCard ? `<img class="ap-card-bg" src="${esc(v.nameCard)}" loading="lazy" onerror="this.remove()"/>` : ""}
        <div class="ap-card-mask"></div>
        <div class="ap-card-top">
          <div class="ap-card-portrait q${v.quality}">
            <img src="${esc(v.icon)}" loading="lazy" onerror="this.style.opacity=0.2"/>
            <span class="ap-badge pill">Lv.${v.level}</span>
            <span class="ap-badge corner">✦${v.constellationCount}</span>
          </div>
          <div class="ap-card-title">
            <b>${esc(v.name)}</b>
            <span class="ap-card-sub">♥ 好感 ${v.fetter} · ${v.weaponTypeLabel}</span>
          </div>
          <div class="ap-card-weapon q${v.weapon.quality}" title="${esc(v.weapon.name)} Lv.${v.weapon.level} · 精${v.weapon.affix}">
            <img src="${esc(v.weapon.icon)}" loading="lazy" onerror="this.style.opacity=0.2"/>
            <span class="ap-badge pill">Lv.${v.weapon.level}</span>
          </div>
        </div>
        <div class="ap-card-skills">
          ${v.skills
            .map((s, i) => `<span class="ap-skill-pill" title="${esc(s.name)} Lv.${s.level}"><b>${SKILL_LABELS[i + 1] ?? "?"}</b> ${s.level}</span>`)
            .join("")}
        </div>
      </button>`;
    })
    .join("")}</div>`;
}

// ---------------------------------------------------------------------------
// 列表视图（对应原版 SplitView：左角色列表 + 右详情面板）
// ---------------------------------------------------------------------------

function renderListDetail(list: AvatarView[]): string {
  const cur = currentIdx >= 0 ? views[currentIdx] : undefined;
  return `
  <div class="ap-split">
    <div class="ap-split-pane">
      ${list
        .map(
          (v) => `
        <button class="ap-list-item ${v === cur ? "active" : ""}" data-id="${v.id}">
          <img class="ap-side-icon" src="${esc(v.sideIcon)}" loading="lazy" onerror="this.style.opacity=0.2"/>
          <span class="ap-list-text"><b>${esc(v.name)}</b><small>Lv.${v.level} · 命${v.constellationCount}</small></span>
        </button>`,
        )
        .join("")}
      <div class="ap-list-count">共 ${list.length} 个角色</div>
    </div>
    <div class="ap-split-main">${cur ? renderDetail(cur) : `<div class="ap-no-select">选择一个角色查看详情</div>`}</div>
  </div>`;
}

function renderDetail(v: AvatarView): string {
  return `
  <div class="ap-detail">
    <!-- 卡片面板：名片 + 黑遮罩 + 角色/武器/技能/命座 -->
    <div class="ap-hero">
      ${v.nameCard ? `<img class="ap-hero-bg" src="${esc(v.nameCard)}" loading="lazy" onerror="this.remove()"/>` : ""}
      <div class="ap-hero-mask"></div>
      <div class="ap-hero-left">
        <div class="ap-hero-id">
          <div class="ap-icon big q${v.quality}"><img src="${esc(v.icon)}" loading="lazy" onerror="this.style.opacity=0.2"/></div>
          <div class="ap-hero-name">
            <b>${esc(v.name)}</b>
            <div class="ap-stars">${starIcons(v.promoteArray)}</div>
            <span>Lv.${v.level}</span>
            <span class="ap-fetter-line">♥ 好感 ${v.fetter}</span>
          </div>
        </div>
        <div class="ap-hero-weapon">
          <div class="ap-icon q${v.weapon.quality}"><img src="${esc(v.weapon.icon)}" loading="lazy" onerror="this.style.opacity=0.2"/></div>
          <div class="ap-weapon-info">
            <b>${esc(v.weapon.name || "武器")}</b>
            <div class="ap-stars small">${starIcons(Array.from({ length: 6 }, (_, i) => i < v.weapon.promote))}</div>
            <span>Lv.${v.weapon.level} · 精${v.weapon.affix}</span>
          </div>
        </div>
      </div>
      <div class="ap-hero-skills">
        ${v.skills
          .map(
            (s, i) => `
          <div class="ap-skill-tile big" title="${esc(s.name)} Lv.${s.level}">
            <img src="${esc(iconUrl(s.icon))}" loading="lazy" onerror="this.remove()"/>
            <b>${SKILL_LABELS[i + 1] ?? "?"}</b><span>Lv.${s.level}</span>
          </div>`,
          )
          .join("")}
      </div>
      <div class="ap-hero-cons">
        ${v.constellations
          .map(
            (k) => `
        <button class="ap-cons-btn" data-cons='${esc(JSON.stringify({ name: k.name, effect: k.effect }))}'>
          <img class="${k.activated ? "" : "off"}" src="${esc(k.icon)}" loading="lazy" onerror="this.style.opacity=0.15"/>
          ${k.activated ? "" : `<span class="ap-lock">🔒</span>`}
        </button>`,
          )
          .join("")}
      </div>
    </div>

    <!-- 角色属性 -->
    <div class="ap-props">
      <div class="ap-props-title">属性</div>
      ${v.properties
        .map(
          (p) => `
        <div class="ap-prop-row">
          <span>${esc(p.name)}</span>
          <span class="ap-prop-val">${esc(p.value)}</span>
          ${p.add ? `<span class="ap-prop-add">${esc(p.add)}</span>` : `<span></span>`}
        </div>`,
        )
        .join("")}
    </div>

    <!-- 圣遗物 -->
    <div class="ap-relics">
      ${v.reliquaries
        .map(
          (r) => `
      <div class="ap-relic">
        <div class="ap-relic-head">
          <div class="ap-icon q${r.rarity}"><img src="${esc(iconUrl(r.icon))}" loading="lazy" onerror="this.style.opacity=0.2"/></div>
          <div><b>${esc(r.name)}</b><small>${esc(r.pos_name)} · ${esc(r.set?.name ?? "")}</small></div>
        </div>
        <div class="ap-relic-main"><b>${esc(FIGHT_PROP_NAMES[r.main_property.property_type] ?? "")}</b><b>${esc(propValue(r.main_property.property_type, r.main_property.val))}</b></div>
        <div class="ap-relic-subs">
          ${r.sub_property_list
            .map(
              (sp) => `
          <div class="ap-relic-sub">
            <span>${esc(FIGHT_PROP_NAMES[sp.property_type] ?? "")}</span>
            <span>${esc(propValue(sp.property_type, sp.val))}</span>
          </div>`,
            )
            .join("")}
        </div>
      </div>`,
        )
        .join("")}
    </div>
  </div>`;
}

function bindBodyEvents(body: HTMLElement): void {
  body.querySelectorAll<HTMLButtonElement>(".ap-card, .ap-list-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const target = views.findIndex((v) => v.id === id);
      if (target >= 0) {
        currentIdx = target;
        // 网格点选仅高亮；列表点选刷新详情
        if (layout === "list") {
          renderBody();
        } else {
          body.querySelectorAll(".ap-card").forEach((c) => c.classList.remove("active"));
          btn.classList.add("active");
        }
      }
    });
  });
  body.querySelectorAll<HTMLButtonElement>(".ap-cons-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      try {
        const info = JSON.parse(btn.dataset.cons ?? "{}") as { name: string; effect: string };
        toast(`${info.name}：${info.effect}`, "info");
      } catch {
        /* 忽略 */
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 导出练度统计文本（对应原版 ExportToTextCommand 的简化版：复制到剪贴板）
// ---------------------------------------------------------------------------

async function exportToText(): Promise<void> {
  if (views.length === 0) {
    return;
  }
  const lines: string[] = ["我的角色练度统计", "".padEnd(24, "=")];
  for (const v of sortedFiltered()) {
    const skills = v.skills.map((s, i) => `${SKILL_LABELS[i + 1] ?? "?"}${s.level}`).join("/");
    const relics = v.reliquaries.map((r) => `+${Math.max(0, r.level - 1)}`).join(" ");
    lines.push(
      `${v.name} Lv.${v.level} 命${v.constellationCount} ♥${v.fetter} | ${v.weaponTypeLabel} Lv.${v.weapon.level} R${v.weapon.affix} | ${skills} | ${relics}`,
    );
  }
  lines.push("".padEnd(24, "="), `导出时间 ${new Date().toLocaleString("zh-CN")}`);
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    toast("练度统计已复制到剪贴板", "success");
  } catch {
    toast("复制失败，请检查剪贴板权限", "error");
  }
}
