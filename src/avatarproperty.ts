// 我的角色（复刻原版 AvatarPropertyPage：CommandBar 卡片 + 列表/网格双布局、排序、Token 筛选、导出；
// 列表布局右侧为角色详情：名片大卡 / 角色属性 Expander / 推荐主属性 / 圣遗物评分）。
// 数据：index + character/list + character/detail 三接口前端组装；
// 图片只使用接口返回的米哈游官方 URL（act-webstatic），不经任何第三方镜像。
import "./avatarproperty.css";
import {
  api,
  type AvatarPropertyDto,
  type CharacterListItem,
  type DetailedCharacter,
  type PanelProperty,
  type Reliquary,
  type UserDto,
} from "./api";
import { closeFlyout, openFlyout, openMenuFlyout } from "./flyout";
import { img } from "./img";
import { isMobile } from "./platform";
import { currentRoleOf } from "./role";
import { bindSelect, selectTrigger } from "./select";
import { closeDialog, openDialog, toast } from "./ui";
import { fetchWithVerification, isRiskError } from "./verify";

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// 常量（对应原版 Model.Intrinsic：FightProperty / ElementType / WeaponType / QualityType）
// ---------------------------------------------------------------------------

/** property_map 缺失时的兜底名称 */
const FIGHT_PROP_NAMES: Record<number, string> = {
  1: "基础生命值", 2: "生命值", 3: "生命值", 4: "基础攻击力", 5: "攻击力", 6: "攻击力",
  7: "基础防御力", 8: "防御力", 9: "防御力", 20: "暴击率", 22: "暴击伤害", 23: "元素充能效率",
  26: "治疗加成", 27: "受治疗加成", 28: "元素精通", 29: "物理抗性", 30: "物理伤害加成",
  40: "火元素伤害加成", 41: "雷元素伤害加成", 42: "水元素伤害加成", 43: "草元素伤害加成",
  44: "风元素伤害加成", 45: "岩元素伤害加成", 46: "冰元素伤害加成",
  50: "火元素抗性", 51: "雷元素抗性", 52: "水元素抗性", 53: "草元素抗性",
  54: "风元素抗性", 55: "岩元素抗性", 56: "冰元素抗性",
  80: "冷却缩减", 81: "护盾强效", 2000: "生命值上限", 2001: "攻击力", 2002: "防御力",
};

/** 游戏内面板顺序（对应 InGameFightPropertyComparer），未列出的按数值排在后面 */
const IN_GAME_ORDER: Record<number, number> = {
  2000: 1, 2001: 2, 2002: 3, 28: 4, 20: 6, 22: 7, 26: 8, 27: 9, 23: 10, 80: 11, 81: 12,
  40: 13, 50: 14, 42: 15, 52: 16, 43: 17, 53: 18, 41: 19, 51: 20, 44: 21, 54: 22,
  46: 23, 56: 24, 45: 25, 55: 26, 30: 27, 29: 28,
};

/** 接口元素 → 中文名 / ElementType 数值（排序用） / 筛选点颜色 */
const ELEMENTS: Record<string, { label: string; order: number; color: string }> = {
  Pyro: { label: "火", order: 1, color: "#ef7938" },
  Hydro: { label: "水", order: 2, color: "#4cc2f1" },
  Dendro: { label: "草", order: 3, color: "#a5c83b" },
  Electro: { label: "雷", order: 4, color: "#af8ec1" },
  Cryo: { label: "冰", order: 5, color: "#9fd6e3" },
  Anemo: { label: "风", order: 7, color: "#73daca" },
  Geo: { label: "岩", order: 8, color: "#ffb628" },
};

const WEAPON_TYPES: Record<number, string> = { 1: "单手剑", 10: "法器", 11: "双手剑", 12: "弓", 13: "长柄武器" };

const QUALITY_NAMES: Record<number, string> = { 5: "五星", 4: "四星" };

/** 珊瑚宫心海：双爆不强制视为有效（对应 AvatarIds.IsCritEffective） */
const KOKOMI_ID = 10000054;
const TARTAGLIA_ID = 10000033;

/** 圣遗物部位 emoji（对应 AvatarViewTextTemplating.ReliquaryEmoji） */
const RELIC_EMOJI: Record<number, string> = { 1: "🌷", 2: "🪶", 3: "⏳", 4: "🍷", 5: "👑" };

// ---------------------------------------------------------------------------
// 视图模型（对应原版 AvatarView / WeaponView / SkillView / ReliquaryView）
// ---------------------------------------------------------------------------

interface NameValue {
  name: string;
  value: string;
}

interface SkillView {
  name: string;
  icon: string;
  description: string;
  /** "Lv. 13 (10 +3)" 形式（对应 LevelFormat.Format(value, extra)） */
  level: string;
  levelNumber: number;
  parameters: NameValue[];
}

interface ConstellationView {
  name: string;
  icon: string;
  description: string;
  activated: boolean;
}

interface PropertyView {
  type: number;
  name: string;
  icon: string;
  value: string;
  add: string;
}

interface ReliquaryView {
  name: string;
  icon: string;
  quality: number;
  pos: number;
  setName: string;
  level: string;
  main: NameValue;
  subs: { name: string; value: string; enhanced: number }[];
  score: number;
}

interface WeaponView {
  name: string;
  icon: string;
  quality: number;
  levelNumber: number;
  affix: number;
  promote: boolean[];
  main: NameValue | null;
  sub: NameValue | null;
  description: string;
  type: number;
}

interface AvatarView {
  id: number;
  name: string;
  element: string;
  quality: number;
  levelNumber: number;
  fetter: number;
  constellationCount: number;
  promote: boolean[];
  icon: string;
  sideIcon: string;
  /** 名片位背景：接口无名片图，使用官方立绘 */
  background: string;
  weapon: WeaponView;
  skills: SkillView[];
  constellations: ConstellationView[];
  properties: PropertyView[];
  reliquaries: ReliquaryView[];
  score: number;
  recommended: { sand: string[]; goblet: string[]; circlet: string[]; sub: string[] };
  maxHp: number;
  curAttack: number;
  curDefense: number;
  elementMastery: number;
}

/** 只接受官方接口给的完整 URL（名字型 UI_xxx 等一律不展示），并走本地图像缓存 */
const officialUrl = img;

function num(s: string | number | undefined): number {
  if (typeof s === "number") {
    return s;
  }
  return Number.parseFloat(String(s ?? "").replace(/[%,]/g, "")) || 0;
}

/** 等级 → 突破阶段（接口不返回角色突破等级，按等级上限推断） */
function promoteOfLevel(level: number): number {
  if (level > 80) return 6;
  if (level > 70) return 5;
  if (level > 60) return 4;
  if (level > 50) return 3;
  if (level > 40) return 2;
  if (level > 20) return 1;
  return 0;
}

/** 米哈游富文本：<color=#RRGGBBAA>、{LINK#..}..{/LINK}、字面量 \n → HTML */
function richText(raw: string): string {
  const text = raw.replace(/\\n/g, "\n").replace(/\{LINK#[^}]*\}|\{\/LINK\}/g, "");
  let html = "";
  let last = 0;
  const re = /<color=(#[0-9A-Fa-f]{6,8})>([\s\S]*?)<\/color>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    html += esc(text.slice(last, m.index));
    html += `<span class="rt-color" style="color:${m[1]}">${esc(m[2])}</span>`;
    last = m.index + m[0].length;
  }
  html += esc(text.slice(last));
  return html.replace(/\n/g, "<br>");
}

function plainText(raw: string): string {
  return raw.replace(/\\n/g, "\n").replace(/<[^>]+>|\{LINK#[^}]*\}|\{\/LINK\}/g, "");
}

// ---- 圣遗物评分（对应 ReliquaryScoreCalculator；接口无特殊能量类型，按常规角色处理）----

function scoreStat(type: number, value: number, weight: number): number {
  switch (type) {
    case 20: return value * 2.0 * weight;
    case 22: return value * 1.0 * weight;
    case 28: return value * 0.33 * weight;
    case 23: return value * 1.1979 * weight;
    case 3: return value * 1.33 * weight;
    case 6: return value * 1.33 * weight;
    case 9: return value * 1.06 * weight;
    case 5: return value * 0.398 * 0.5 * weight;
    case 2: return value * 0.026 * 0.66 * weight;
    case 8: return value * 0.335 * 0.66 * weight;
    default: return 0;
  }
}

function relicScore(subs: { property_type: number; value: string }[], recommended: number[], isCritEffective: boolean): number {
  const hasCritHurt = isCritEffective || recommended.includes(22);
  let total = 0;
  for (const s of subs) {
    const type = s.property_type;
    let weight: number;
    if (isCritEffective && (type === 20 || type === 22)) {
      weight = 1;
    } else if (type === 23 && !recommended.includes(23)) {
      weight = hasCritHurt ? 0.2 : 1;
    } else if (!recommended.includes(type)) {
      weight = 0;
    } else {
      weight = type === 2 || type === 5 || type === 8 ? 0.5 : 1;
    }
    if (weight > 0) {
      total += scoreStat(type, num(s.value), weight);
    }
  }
  return total;
}

/** 渐变色（对应 Int32ToGradientColorConverter / UInt32ToGradientColorConverter） */
function gradient(value: number, min: number, max: number, from: string, to: string): string {
  const t = (Math.min(Math.max(value, min), max) - min) / (max - min);
  const a = from.match(/\w\w/g)!.map((h) => Number.parseInt(h, 16));
  const b = to.match(/\w\w/g)!.map((h) => Number.parseInt(h, 16));
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}

const scoreColor = (s: number, max: number): string => gradient(Math.round(s), 0, max, "9E9E9E", "FF8F00");
const enhancedColor = (count: number): string =>
  document.documentElement.dataset.theme === "light" ? gradient(count, 1, 6, "4B00D9", "FD0093") : gradient(count, 1, 6, "9F69FF", "FF69BF");

const fmtScore = (s: number): string => `${s.toFixed(1)} 分`;

/** 命座/固有天赋带来的技能等级提升（对应 ProcessConstellations 的 ExtraLevel） */
function extraLevels(detail: DetailedCharacter, combatSkills: { name: string }[]): Map<number, number> {
  const extras = new Map<number, number>();
  for (const c of detail.constellations ?? []) {
    if (!c.is_actived) {
      continue;
    }
    const m = /(.+?)的技能等级提升(\d+)级/.exec(plainText(c.effect));
    if (m) {
      const idx = combatSkills.findIndex((s) => m[1].endsWith(s.name));
      if (idx >= 0) {
        extras.set(idx, (extras.get(idx) ?? 0) + Number(m[2]));
      }
    }
  }
  // 达达利亚固有天赋「诸武精通」：普通攻击等级 +1（原版按固有天赋 GroupId 3323 判定）
  if (detail.base.id === TARTAGLIA_ID) {
    extras.set(0, (extras.get(0) ?? 0) + 1);
  }
  return extras;
}

function buildAvatarViews(dto: AvatarPropertyDto): AvatarView[] {
  const propMap = dto.detail?.property_map ?? {};
  const propName = (t: number): string => propMap[t]?.name ?? FIGHT_PROP_NAMES[t] ?? `属性${t}`;
  const filterName = (t: number): string => (propMap[t] as { filter_name?: string } | undefined)?.filter_name ?? propName(t);
  const propIcon = (t: number): string => officialUrl(propMap[t]?.icon);

  const detailById = new Map<number, DetailedCharacter>();
  for (const d of dto.detail?.list ?? []) {
    detailById.set(d.base.id, d);
  }

  const views: AvatarView[] = [];
  for (const c of dto.list?.list ?? []) {
    const detail = detailById.get(c.id);
    if (!detail) {
      continue;
    }
    views.push(buildOne(c, detail));
  }
  return views;

  function buildOne(c: CharacterListItem, detail: DetailedCharacter): AvatarView {
    const level = num(c.level);
    const isCritEffective = c.id !== KOKOMI_ID;
    const rec = detail.recommend_relic_property?.recommend_properties ?? {};
    const recommendedSubs = rec.sub_property_list ?? [];

    // 战斗天赋：skill_type=1 且不是替代冲刺（对应 CompositeSkillsNoInherents）
    const combat = (detail.skills ?? []).filter((s) => s.skill_type === 1 && !plainText(s.desc).startsWith("替代冲刺"));
    const extras = extraLevels(detail, combat);
    const skills: SkillView[] = combat.map((s, i) => {
      const extra = extras.get(i) ?? 0;
      const base = s.level - extra;
      return {
        name: s.name,
        icon: officialUrl(s.icon),
        description: s.desc,
        level: extra > 0 ? `Lv. ${s.level} (${base} +${extra})` : `Lv. ${s.level}`,
        levelNumber: base,
        parameters: (s.skill_affix_list ?? []).map((a) => ({ name: a.name, value: a.value })),
      };
    });

    const properties: PropertyView[] = [...(detail.selected_properties ?? [])]
      .sort((a, b) => (IN_GAME_ORDER[a.property_type] ?? 100 + a.property_type) - (IN_GAME_ORDER[b.property_type] ?? 100 + b.property_type))
      .map((p) => ({
        type: p.property_type,
        name: propName(p.property_type),
        icon: propIcon(p.property_type),
        value: p.base,
        add: p.add ?? "",
      }));
    const finalOf = (t: number): number => num(detail.selected_properties?.find((p) => p.property_type === t)?.final);

    const reliquaries: ReliquaryView[] = [...(detail.relics ?? [])]
      .sort((a, b) => a.pos - b.pos)
      .map((r: Reliquary) => ({
        name: r.name,
        icon: officialUrl(r.icon),
        quality: r.rarity,
        pos: r.pos,
        setName: r.set?.name ?? "",
        level: `+${r.level}`,
        main: { name: propName(r.main_property.property_type), value: r.main_property.value },
        subs: r.sub_property_list.map((s) => ({ name: propName(s.property_type), value: s.value, enhanced: (s.times ?? 0) + 1 })),
        score: relicScore(r.sub_property_list, recommendedSubs, isCritEffective),
      }));

    const w = detail.weapon;
    const weaponPromoteMax = w.rarity >= 3 ? 6 : 4;
    const toNv = (p: PanelProperty | null | undefined): NameValue | null => (p && p.final ? { name: propName(p.property_type), value: p.final } : null);
    const weapon: WeaponView = {
      name: w.name ?? c.weapon?.name ?? "",
      icon: officialUrl(w.icon ?? c.weapon?.icon),
      quality: w.rarity,
      levelNumber: num(w.level),
      affix: w.affix_level,
      promote: Array.from({ length: weaponPromoteMax }, (_, i) => i < (w.promote_level ?? promoteOfLevel(num(w.level)))),
      main: toNv(w.main_property),
      sub: toNv(w.sub_property),
      description: w.desc ?? "",
      type: w.type ?? c.weapon?.type ?? 0,
    };

    return {
      id: c.id,
      name: c.name,
      element: c.element,
      quality: c.rarity,
      levelNumber: level,
      fetter: c.fetter,
      constellationCount: c.actived_constellation_num,
      promote: Array.from({ length: 6 }, (_, i) => i < promoteOfLevel(level)),
      icon: officialUrl(c.icon),
      sideIcon: officialUrl(c.side_icon),
      background: officialUrl(c.image),
      weapon,
      skills,
      constellations: (detail.constellations ?? [])
        .slice()
        .sort((a, b) => a.pos - b.pos)
        .map((k) => ({ name: k.name, icon: officialUrl(k.icon), description: k.effect, activated: k.is_actived })),
      properties,
      reliquaries,
      score: reliquaries.reduce((s, r) => s + r.score, 0),
      recommended: {
        sand: (rec.sand_main_property_list ?? []).map(filterName),
        goblet: (rec.goblet_main_property_list ?? []).map(filterName),
        circlet: (rec.circlet_main_property_list ?? []).map(filterName),
        sub: recommendedSubs.map(filterName),
      },
      maxHp: finalOf(2000),
      curAttack: finalOf(2001),
      curDefense: finalOf(2002),
      elementMastery: finalOf(28),
    };
  }
}

// ---------------------------------------------------------------------------
// 排序 / 筛选（对应 AvatarPropertySortDescriptions / AvatarViewFilter）
// ---------------------------------------------------------------------------

type SortKind = "Default" | "LevelNumber" | "Quality" | "ActivatedConstellationCount" | "FetterLevel" | "MaxHp" | "CurAttack" | "CurDefense" | "ElementMastery";

const SORTS: { key: SortKind; label: string }[] = [
  { key: "Default", label: "默认顺序" },
  { key: "LevelNumber", label: "等级顺序" },
  { key: "Quality", label: "品质顺序" },
  { key: "ActivatedConstellationCount", label: "命之座解锁层数顺序" },
  { key: "FetterLevel", label: "好感度顺序" },
  { key: "MaxHp", label: "生命值上限顺序" },
  { key: "CurAttack", label: "攻击力顺序" },
  { key: "CurDefense", label: "防御力顺序" },
  { key: "ElementMastery", label: "元素精通顺序" },
];

const SORT_OPTIONS = SORTS.map((s) => ({ value: s.key, label: s.label }));

type SortField = (v: AvatarView) => number;
const F = {
  level: (v: AvatarView) => v.levelNumber,
  quality: (v: AvatarView) => v.quality,
  element: (v: AvatarView) => ELEMENTS[v.element]?.order ?? 0,
  id: (v: AvatarView) => v.id,
} satisfies Record<string, SortField>;

const SORT_FIELDS: Record<SortKind, SortField[]> = {
  Default: [],
  LevelNumber: [F.level, F.quality, F.element, F.id],
  Quality: [F.quality, F.level, F.element, F.id],
  ActivatedConstellationCount: [(v) => v.constellationCount, F.level, F.quality, F.element, F.id],
  FetterLevel: [(v) => v.fetter, F.level, F.quality, F.element, F.id],
  MaxHp: [(v) => v.maxHp, F.level, F.quality, F.element, F.id],
  CurAttack: [(v) => v.curAttack, F.level, F.quality, F.element, F.id],
  CurDefense: [(v) => v.curDefense, F.level, F.quality, F.element, F.id],
  ElementMastery: [(v) => v.elementMastery, F.level, F.quality, F.element, F.id],
};

type TokenKind = "element" | "quality" | "weapon" | "none";

interface SearchToken {
  kind: TokenKind;
  value: string;
  color?: string;
}

const AVAILABLE_TOKENS: SearchToken[] = [
  ...Object.values(ELEMENTS).map((e) => ({ kind: "element" as const, value: e.label, color: e.color })),
  { kind: "quality", value: "五星", color: "#bc6932" },
  { kind: "quality", value: "四星", color: "#a256e1" },
  ...Object.values(WEAPON_TYPES).map((w) => ({ kind: "weapon" as const, value: w })),
];

const MAX_TOKENS = 5;

function matchesTokens(v: AvatarView, tokens: SearchToken[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  const groups = new Map<TokenKind, string[]>();
  for (const t of tokens) {
    groups.set(t.kind, [...(groups.get(t.kind) ?? []), t.value]);
  }
  for (const [kind, values] of groups) {
    const ok =
      kind === "element" ? values.includes(ELEMENTS[v.element]?.label ?? "")
      : kind === "quality" ? values.includes(QUALITY_NAMES[v.quality] ?? "")
      : kind === "weapon" ? values.includes(WEAPON_TYPES[v.weapon.type] ?? "")
      : values.some((s) => v.name.toLowerCase().includes(s.toLowerCase()));
    if (!ok) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 页面状态
// ---------------------------------------------------------------------------

const SORT_KEY = "hoyo-avatar-property-sort";
const LAYOUT_KEY = "hoyo-avatar-property-layout";

/** 视图缓存按 用户:角色 区分，切换角色不会串数据 */
let viewsKey = "";
let views: AvatarView[] = [];
let currentId: number | null = null;
let lastUpdated = 0;
let refreshing = false;
let tokens: SearchToken[] = [];
let sortKind: SortKind = (localStorage.getItem(SORT_KEY) as SortKind | null) ?? "Default";
let layout: "List" | "Grid" = localStorage.getItem(LAYOUT_KEY) === "Grid" ? "Grid" : "List";

function visibleViews(): AvatarView[] {
  const out = views.filter((v) => matchesTokens(v, tokens));
  const fields = SORT_FIELDS[sortKind];
  if (fields.length > 0) {
    out.sort((a, b) => {
      for (const f of fields) {
        const d = f(b) - f(a);
        if (d !== 0) {
          return d;
        }
      }
      return 0;
    });
  }
  return out;
}

function currentView(list: AvatarView[]): AvatarView | undefined {
  return list.find((v) => v.id === currentId);
}

// ---------------------------------------------------------------------------
// 共用片段
// ---------------------------------------------------------------------------

const SVG_FETTER = `<svg class="ap-fetter" viewBox="0 0 16 16"><path d="M8 14.2 2.6 8.8A3.3 3.3 0 0 1 8 4.4a3.3 3.3 0 0 1 5.4 4.4z"/></svg>`;
const SVG_KIRA = `<svg viewBox="0 0 12 12"><path d="M6 .5 7.2 4.8 11.5 6 7.2 7.2 6 11.5 4.8 7.2.5 6 4.8 4.8z"/></svg>`;
const SVG_LOCK = `<svg class="ap-lock" viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;
const SVG_CHEVRON = `<svg class="ap-chev" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>`;

/** 物品图标：品质渐变底 + 图片（对应 ItemIcon） */
function itemIcon(icon: string, quality: number, size: number, extra = ""): string {
  const q = Math.min(Math.max(quality, 1), 5);
  return `<div class="item-icon q${q}" style="width:${size}px;height:${size}px">${icon ? `<img src="${esc(icon)}" loading="lazy" onerror="this.remove()"/>` : ""}${extra}</div>`;
}

function promoteStars(arr: boolean[]): string {
  return `<span class="ap-promote">${arr.map((on) => `<i class="${on ? "on" : ""}">${SVG_KIRA}</i>`).join("")}</span>`;
}

function emptyCard(title: string, inner: string): string {
  return `<div class="ap-empty"><div class="ap-empty-card"><div class="ap-empty-title">${esc(title)}</div>${inner}</div></div>`;
}

/** Flyout 内容缓存：按钮只带 key，避免把长文本塞进属性 */
let flyoutData = new Map<string, () => string>();

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------

export function renderAvatarPropertyPage(content: HTMLElement, user: UserDto | undefined): void {
  content.classList.add("content-flush");
  const role = currentRoleOf(user);
  if (!user || !role) {
    content.innerHTML = emptyCard("尚未登录", `<p class="ap-empty-desc">登录米游社账号并选择角色后可查看角色练度</p>`);
    return;
  }

  const key = `${user.id}:${role.game_uid}`;
  if (key !== viewsKey) {
    viewsKey = key;
    views = [];
    currentId = null;
    lastUpdated = 0;
  }

  content.innerHTML = `<div class="ap-page" id="ap-page"></div>`;
  const page = document.getElementById("ap-page")!;
  const refresh = (): void => void doRefresh(user, role.game_uid, page);

  if (views.length > 0) {
    renderMain(page, refresh);
    return;
  }
  renderEmpty(page, refresh);
  // 进入页面先读本地缓存（不触网；对应原版 RefreshOptionKind.None）
  void api
    .avatarPropertyCache(user.id, role.game_uid)
    .then((cached) => {
      if (cached && viewsKey === key && views.length === 0) {
        views = buildAvatarViews(cached.data);
        lastUpdated = cached.updated_at;
        console.info(`[avatar_property] 已加载本地缓存（${views.length} 个角色）`);
        if (document.getElementById("ap-page") === page) {
          renderMain(page, refresh);
        }
      }
    })
    .catch((e: unknown) => console.warn(`[avatar_property] 缓存读取失败: ${e instanceof Error ? e.message : String(e)}`));
}

function renderEmpty(page: HTMLElement, refresh: () => void): void {
  page.innerHTML = emptyCard(
    "尚未获取任何角色信息",
    `<button class="settings-card" id="ap-empty-refresh" title="同步">
      <span class="settings-card-text">从米游社原神战绩同步</span>${SVG_CHEVRON}
    </button>`,
  );
  document.getElementById("ap-empty-refresh")?.addEventListener("click", refresh);
}

async function doRefresh(user: UserDto, gameUid: string, page: HTMLElement): Promise<void> {
  if (refreshing) {
    return;
  }
  refreshing = true;
  const key = viewsKey;
  console.info("[avatar_property] 同步角色信息…");
  openDialog("获取数据中", `<div class="ap-progress"><span class="ap-spin"></span></div>`, null, { cancelable: false });
  try {
    const dto = await fetchWithVerification(user.id, (ch) => api.avatarPropertyRefresh(user.id, gameUid, ch));
    if (viewsKey !== key) {
      return;
    }
    views = buildAvatarViews(dto);
    lastUpdated = Date.now();
    console.info(`[avatar_property] 同步完成（${views.length} 个角色）`);
    toast(`已同步 ${views.length} 个角色`, "success");
    if (document.getElementById("ap-page") === page) {
      renderMain(page, () => void doRefresh(user, gameUid, page));
    }
  } catch (e) {
    if (!isRiskError(e)) {
      console.warn(`[avatar_property] 同步失败: ${e instanceof Error ? e.message : String(e)}`);
      toast(`同步失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  } finally {
    refreshing = false;
    closeDialog();
  }
}

// ---------------------------------------------------------------------------
// CommandBar + 主体
// ---------------------------------------------------------------------------

function renderMain(page: HTMLElement, refresh: () => void): void {
  closeFlyout();
  const syncTitle = lastUpdated > 0 ? `同步角色信息（上次同步 ${new Date(lastUpdated).toLocaleString("zh-CN")}）` : "同步角色信息";
  // 布局：左（布局切换 + 排序）固定宽，筛选框弹性伸缩，右侧操作按钮窄宽度下自动收为纯图标；
  // 仍放不下时整体换行，各控件之间绝不重叠
  page.innerHTML = `
    <div class="ap-commandbar card">
      <div class="ap-cb-left">
        <div class="segmented" id="ap-layout">
          <button data-layout="List" title="列表"><svg viewBox="0 0 16 16"><path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg></button>
          <button data-layout="Grid" title="网格"><svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx=".8"/><rect x="9" y="2.5" width="4.5" height="4.5" rx=".8"/><rect x="2.5" y="9" width="4.5" height="4.5" rx=".8"/><rect x="9" y="9" width="4.5" height="4.5" rx=".8"/></svg></button>
        </div>
        ${selectTrigger("ap-sort", SORT_OPTIONS, sortKind, { cls: "ap-sort" })}
      </div>
      <div class="ap-filter sc-input" id="ap-tokens"></div>
      <div class="ap-cb-right">
        <button class="appbar-btn" id="ap-export" title="导出文本到剪贴板"><svg viewBox="0 0 16 16"><rect x="4" y="2.5" width="8" height="11" rx="1"/><path d="M6 2.5V2h4v.5M6 6h4M6 8.5h4M6 11h2.5"/></svg><span class="lbl">导出文本到剪贴板</span></button>
        <button class="appbar-btn" id="ap-calc" title="养成计算"><svg viewBox="0 0 16 16"><rect x="3" y="2" width="10" height="12" rx="1.2"/><path d="M5 4.5h6M5.5 7.5h.01M8 7.5h.01M10.5 7.5h.01M5.5 10h.01M8 10h.01M10.5 10h.01M5.5 12h.01M8 12h.01M10.5 12h.01"/></svg><span class="lbl">养成计算</span></button>
        <span class="appbar-sep"></span>
        <button class="appbar-btn" id="ap-refresh" title="${esc(syncTitle)}"><svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5V5h-2.5"/></svg><span class="lbl">同步角色信息</span></button>
      </div>
    </div>
    <div class="ap-body card" id="ap-body"></div>`;

  page.querySelectorAll<HTMLButtonElement>("#ap-layout button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.layout === layout);
    btn.addEventListener("click", () => {
      layout = btn.dataset.layout === "Grid" ? "Grid" : "List";
      localStorage.setItem(LAYOUT_KEY, layout);
      page.querySelectorAll<HTMLButtonElement>("#ap-layout button").forEach((b) => b.classList.toggle("active", b === btn));
      renderBody();
    });
  });
  bindSelect(page.querySelector<HTMLButtonElement>("#ap-sort")!, SORT_OPTIONS, sortKind, (value) => {
    sortKind = value as SortKind;
    localStorage.setItem(SORT_KEY, sortKind);
    // 对应 PrivateSortAvatars → MoveCurrentToFirst
    currentId = visibleViews()[0]?.id ?? null;
    renderBody(true);
  });
  const exportBtn = page.querySelector<HTMLButtonElement>("#ap-export")!;
  exportBtn.addEventListener("click", () =>
    openMenuFlyout(exportBtn, [
      { label: "导出当前角色", onClick: () => void exportText(false) },
      { label: "导出所有角色", onClick: () => void exportText(true) },
    ]),
  );
  const calcBtn = page.querySelector<HTMLButtonElement>("#ap-calc")!;
  calcBtn.addEventListener("click", () =>
    openMenuFlyout(
      calcBtn,
      ["当前角色与武器", "部分角色与武器", "所有角色与武器"].map((label) => ({ label, disabled: true, title: "养成计划开发中", onClick: () => undefined })),
    ),
  );
  page.querySelector<HTMLButtonElement>("#ap-refresh")!.addEventListener("click", refresh);

  renderTokenBox(page.querySelector<HTMLElement>("#ap-tokens")!);
  renderBody(true);
}

// ---- AutoSuggestTokenBox（shadcn Combobox：Input + Badge + Popover 联想） ----

function tokenDot(t: SearchToken): string {
  return `<i class="token-dot ${t.color ? "" : "none"}" ${t.color ? `style="background:${t.color}"` : ""}></i>`;
}

function renderTokenBox(box: HTMLElement): void {
  const chips = tokens
    .map((t, i) => `<span class="sc-badge">${t.color ? tokenDot(t) : ""}${esc(t.value)}<button type="button" data-rm="${i}" title="移除">×</button></span>`)
    .join("");
  box.innerHTML = `<svg class="token-search" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>${chips}<input id="ap-token-input" role="combobox" autocomplete="off" placeholder="${tokens.length ? "" : "筛选角色"}" ${tokens.length >= MAX_TOKENS ? "disabled" : ""}/>`;

  box.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      tokens.splice(Number(btn.dataset.rm), 1);
      applyFilter(box);
    });
  });
  const input = box.querySelector<HTMLInputElement>("#ap-token-input")!;
  const suggest = (): void => {
    const q = input.value.trim();
    if (input.disabled) {
      return;
    }
    const candidates = AVAILABLE_TOKENS.filter((t) => !tokens.some((x) => x.kind === t.kind && x.value === t.value) && (!q || t.value.includes(q)));
    const html = candidates.length
      ? candidates.map((t, i) => `<button type="button" class="sc-item token-suggest" role="option" data-i="${i}">${tokenDot(t)}<span>${esc(t.value)}</span></button>`).join("")
      : `<div class="sc-empty">${q ? `回车按名称筛选「${esc(q)}」` : "没有更多可选条件"}</div>`;
    const el = openFlyout(box, `<div role="listbox">${html}</div>`, "bottom", "sc-popover", { toggle: false, matchWidth: true });
    el?.querySelectorAll<HTMLButtonElement>(".token-suggest").forEach((btn) => {
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("click", () => {
        tokens.push(candidates[Number(btn.dataset.i)]);
        closeFlyout();
        applyFilter(box);
      });
    });
  };
  input.addEventListener("focus", suggest);
  input.addEventListener("input", suggest);
  // 点击输入框任意空白处都聚焦输入（与 shadcn Input 的整框可点一致）
  box.addEventListener("mousedown", (ev) => {
    if (ev.target === box) {
      ev.preventDefault();
      input.focus();
    }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && input.value.trim()) {
      const text = input.value.trim();
      const exact = AVAILABLE_TOKENS.find((t) => t.value === text);
      tokens.push(exact ?? { kind: "none", value: text });
      closeFlyout();
      applyFilter(box);
    } else if (ev.key === "Backspace" && !input.value && tokens.length) {
      tokens.pop();
      applyFilter(box);
    }
  });
}

function applyFilter(box: HTMLElement): void {
  renderTokenBox(box);
  const list = visibleViews();
  if (!currentView(list)) {
    currentId = list[0]?.id ?? null;
  }
  renderBody(true);
  box.querySelector<HTMLInputElement>("#ap-token-input")?.focus();
}

// ---------------------------------------------------------------------------
// 主体：网格 / 列表 + 详情
// ---------------------------------------------------------------------------

function renderBody(scrollTop = false): void {
  const body = document.getElementById("ap-body");
  if (!body) {
    return;
  }
  flyoutData = new Map();
  const list = visibleViews();
  if (currentId === null || !currentView(list)) {
    currentId = list[0]?.id ?? null;
  }
  body.innerHTML = layout === "Grid" ? renderGrid(list) : renderList(list);
  bindBody(body);
  if (scrollTop) {
    body.querySelectorAll<HTMLElement>(".ap-grid, .ap-split-list, .ap-detail-scroll").forEach((el) => (el.scrollTop = 0));
  }
}

function renderGrid(list: AvatarView[]): string {
  if (list.length === 0) {
    return `<div class="ap-not-found">未找到结果</div>`;
  }
  return `<div class="ap-grid">${list.map(gridItem).join("")}</div>`;
}

function verticalCard(top: string, bottom: string): string {
  return `<div class="vcard"><div class="vcard-top">${top}</div><div class="vcard-bottom">${bottom}</div></div>`;
}

function gridItem(v: AvatarView): string {
  const avatar = verticalCard(
    itemIcon(
      v.icon,
      v.quality,
      64,
      `<span class="ii-bottom">${SVG_FETTER}${v.fetter}</span><span class="ii-corner">${v.constellationCount}</span>`,
    ),
    `Lv. ${v.levelNumber}`,
  );
  const weapon = verticalCard(itemIcon(v.weapon.icon, v.weapon.quality, 64, `<span class="ii-corner">${v.weapon.affix}</span>`), `Lv. ${v.weapon.levelNumber}`);
  const skills = v.skills
    .map((s) => verticalCard(`<div class="ap-grid-skill">${s.icon ? `<img class="mono" src="${esc(s.icon)}" loading="lazy" onerror="this.remove()"/>` : ""}</div>`, String(s.levelNumber)))
    .join("");
  return `
    <button class="ap-grid-item ${v.id === currentId ? "active" : ""}" data-id="${v.id}">
      ${v.background ? `<img class="ap-grid-bg" src="${esc(v.background)}" loading="lazy" onerror="this.remove()"/>` : ""}
      <div class="ap-grid-acrylic"></div>
      <div class="ap-grid-row">${avatar}${weapon}${skills}</div>
    </button>`;
}

function renderList(list: AvatarView[]): string {
  const cur = currentView(list);
  const items = list
    .map(
      (v) => `
      <button class="ap-list-item ${v === cur ? "active" : ""}" data-id="${v.id}">
        <span class="ap-side">${v.sideIcon ? `<img src="${esc(v.sideIcon)}" loading="lazy" onerror="this.remove()"/>` : ""}</span>
        <span class="ap-list-text"><span class="name">${esc(v.name)}</span><span class="lv">Lv. ${v.levelNumber}</span></span>
      </button>`,
    )
    .join("");
  return `
    <div class="ap-split">
      <div class="ap-split-pane">
        <div class="ap-split-list">${items}</div>
        <div class="ap-split-count">共 ${list.length} 位角色</div>
      </div>
      <div class="ap-detail-scroll">${cur ? renderDetail(cur) : `<div class="ap-not-found">未找到结果</div>`}</div>
    </div>`;
}

function renderDetail(v: AvatarView): string {
  const w = v.weapon;
  flyoutData.set("weapon", () => {
    const cards = [w.main, w.sub]
      .filter((p): p is NameValue => !!p)
      .map((p) => `<div class="settings-row"><span>${esc(p.name)}</span><span>${esc(p.value)}</span></div>`)
      .join("");
    return `<div class="ap-fly-weapon">${cards}${w.description ? `<div class="ap-fly-desc">${richText(w.description)}</div>` : ""}</div>`;
  });

  const skills = v.skills
    .map((s, i) => {
      flyoutData.set(`skill${i}`, () => {
        const params = s.parameters.map((p) => `<div class="settings-row"><span>${esc(p.name)}</span><span>${esc(p.value)}</span></div>`).join("");
        return `<div class="ap-fly-text"><div class="ap-fly-desc">${richText(s.description)}</div>${params ? `<div class="ap-fly-params">${params}</div>` : ""}</div>`;
      });
      return `
        <button class="ap-skill" data-fly="skill${i}" data-place="left" title="${esc(s.name)}">
          ${s.icon ? `<img src="${esc(s.icon)}" loading="lazy" onerror="this.remove()"/>` : `<span class="ap-skill-ph"></span>`}
          <span>${esc(s.level)}</span>
        </button>`;
    })
    .join("");

  const cons = v.constellations
    .map((k, i) => {
      flyoutData.set(`cons${i}`, () => `<div class="ap-fly-text"><div class="ap-fly-title">${esc(k.name)}</div><div class="ap-fly-desc">${richText(k.description)}</div></div>`);
      return `
        <button class="ap-cons ${k.activated ? "" : "locked"}" data-fly="cons${i}" title="${esc(k.name)}">
          ${k.icon ? `<img src="${esc(k.icon)}" loading="lazy" onerror="this.remove()"/>` : ""}
          ${k.activated ? "" : SVG_LOCK}
        </button>`;
    })
    .join("");

  const props = v.properties
    .map(
      (p) => `
      <div class="ap-prop">
        <span class="ap-prop-icon">${p.icon ? `<img class="mono" src="${esc(p.icon)}" loading="lazy" onerror="this.remove()"/>` : ""}</span>
        <span class="ap-prop-name">${esc(p.name)}</span>
        <span class="ap-prop-val">${esc(p.value)}</span>
        <span class="ap-prop-add">${esc(p.add)}</span>
      </div>`,
    )
    .join("");

  // 推荐主属性卡右侧配图：该角色当前穿戴的对应部位圣遗物（官方图标）
  const relicIcon = (pos: number): string => {
    const r = v.reliquaries.find((x) => x.pos === pos);
    return r?.icon ? `<img class="ap-rec-img" src="${esc(r.icon)}" loading="lazy" onerror="this.remove()"/>` : "";
  };
  const recCard = (title: string, names: string[], pos?: number): string => `
    <div class="ap-rec vcard">
      <div class="ap-rec-title">${esc(title)}</div>
      <div class="ap-rec-values">${names.map((n) => `<span>${esc(n)}</span>`).join("")}</div>
      ${pos ? relicIcon(pos) : ""}
    </div>`;

  const relics = v.reliquaries
    .map(
      (r) => `
      <div class="ap-relic">
        <div class="ap-relic-head">
          ${itemIcon(r.icon, r.quality, 48)}
          <div class="ap-relic-name"><span>${esc(r.name)}</span><small>${esc(r.setName)}</small></div>
          <b class="ap-relic-score" style="color:${scoreColor(r.score, 50)}">${fmtScore(r.score)}</b>
        </div>
        <div class="ap-relic-main"><b>${esc(r.main.name)}</b><b>${esc(r.main.value)}</b></div>
        <div class="ap-relic-subs">
          ${r.subs
            .map(
              (s) => `
            <div class="ap-relic-sub">
              <b>${esc(s.name)}</b>
              <span>${esc(s.value)}</span>
              <span class="ap-enh" style="color:${enhancedColor(s.enhanced)};border-color:${enhancedColor(s.enhanced)}">${s.enhanced}</span>
            </div>`,
            )
            .join("")}
        </div>
      </div>`,
    )
    .join("");

  return `
  <div class="ap-detail">
    <div class="ap-hero">
      ${v.background ? `<img class="ap-hero-bg" src="${esc(v.background)}" loading="lazy" onerror="this.remove()"/>` : ""}
      <div class="ap-hero-mask"></div>
      <div class="ap-hero-info">
        <div class="ap-hero-row">
          ${itemIcon(v.icon, v.quality, 80)}
          <div class="ap-hero-text">
            <div class="ap-subtitle">${esc(v.name)}</div>
            ${promoteStars(v.promote)}
            <div class="ap-base">Lv. ${v.levelNumber}</div>
            <div class="ap-caption">${SVG_FETTER}${v.fetter}</div>
            <div class="ap-base">角色总分：<b style="color:${scoreColor(v.score, 100)}">${fmtScore(v.score)}</b></div>
          </div>
        </div>
        <div class="ap-hero-row weapon">
          <button class="ap-weapon-btn" data-fly="weapon" data-place="bottom">${itemIcon(w.icon, w.quality, 80)}</button>
          <div class="ap-hero-text">
            <div class="ap-subtitle">${esc(w.name)}</div>
            ${promoteStars(w.promote)}
            <div class="ap-base">Lv. ${w.levelNumber}</div>
            <div class="ap-caption">精炼 ${w.affix}</div>
          </div>
        </div>
      </div>
      <div class="ap-hero-skills">${skills}</div>
      <div class="ap-hero-cons">${cons}</div>
    </div>

    <details class="ap-expander" open>
      <summary><span>角色属性</span>${SVG_CHEVRON}</summary>
      <div class="ap-expander-body">${props}</div>
    </details>

    <div class="ap-recs">
      ${recCard("时之沙主属性推荐", v.recommended.sand, 3)}
      ${recCard("空之杯主属性推荐", v.recommended.goblet, 4)}
      ${recCard("理之冠主属性推荐", v.recommended.circlet, 5)}
      ${recCard("追加属性推荐", v.recommended.sub)}
    </div>

    ${relics ? `<div class="ap-relics">${relics}</div>` : ""}
  </div>`;
}

function bindBody(body: HTMLElement): void {
  body.querySelectorAll<HTMLButtonElement>(".ap-grid-item, .ap-list-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentId = Number(btn.dataset.id);
      if (layout === "List") {
        const list = body.querySelector(".ap-split-list");
        const keep = list?.scrollTop ?? 0;
        renderBody();
        body.querySelector(".ap-split-list")!.scrollTop = keep;
      } else {
        body.querySelectorAll(".ap-grid-item").forEach((c) => c.classList.toggle("active", c === btn));
      }
    });
    // 右键菜单（对应原版 ContextFlyout；养成计划尚未实现，入口置灰）。安卓长按也会触发 contextmenu，
    // 但菜单项全部置灰，长按只会遮挡选择，故移动端不弹
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (isMobile()) {
        return;
      }
      openMenuFlyout(
        btn,
        ["添加角色到养成计划", "添加武器到养成计划", "添加角色与武器到养成计划"].map((label) => ({ label, disabled: true, title: "养成计划开发中", onClick: () => undefined })),
        "right",
      );
    });
  });
  body.querySelectorAll<HTMLButtonElement>("[data-fly]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const html = flyoutData.get(btn.dataset.fly!)?.();
      if (html) {
        openFlyout(btn, html, (btn.dataset.place as "left" | "bottom" | undefined) ?? "bottom", "ap-flyout");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 导出文本（对应 AvatarViewTextTemplating.GetTemplatedText）
// ---------------------------------------------------------------------------

function templatedText(v: AvatarView): string {
  const lines: string[] = ["// =====================", `// ${v.name} [Lv. ${v.levelNumber}, ☆${v.quality}, C${v.constellationCount}] [${v.skills.map((s) => s.level).join(", ")}]`];
  const w = v.weapon;
  lines.push(
    "// ---------------------",
    `// ${w.name} [Lv. ${w.levelNumber}, ☆${w.quality}, ❖${w.affix}]`,
    `// ${w.main ? `[${w.main.name}: ${w.main.value}]` : ""} ${w.sub ? `[${w.sub.name}: ${w.sub.value}]` : ""}`,
  );
  if (v.properties.length > 0) {
    lines.push("// ---------------------");
    for (const p of v.properties) {
      lines.push(`// [${p.name}: ${p.value}${p.add ? ` + ${p.add}` : ""}]`);
    }
  }
  if (v.reliquaries.length > 0) {
    lines.push("// ---------------------");
    for (const r of v.reliquaries) {
      lines.push(`// ${RELIC_EMOJI[r.pos] ?? ""} ${r.main.name}: ${r.main.value} [☆${r.quality} ${r.level} ${r.setName}] 评分: ${fmtScore(r.score)}`);
      lines.push(`// ${r.subs.map((s) => `[${s.name}: ${s.value} ${String.fromCharCode(0x2775 + s.enhanced)}]`).join("")}`);
    }
  }
  lines.push("// =====================");
  return lines.join("\n");
}

async function exportText(all: boolean): Promise<void> {
  const list = visibleViews();
  const target = all ? list : list.filter((v) => v.id === currentId);
  if (target.length === 0) {
    return;
  }
  try {
    await navigator.clipboard.writeText(target.map(templatedText).join("\n"));
    toast("复制角色详情成功", "success");
  } catch {
    toast("复制角色详情失败", "error");
  }
}
