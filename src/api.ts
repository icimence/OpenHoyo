// 与 src-tauri/src/commands.rs 中的 DTO 一一对应
export interface GameRoleDto {
  game_uid: string;
  nickname: string;
  level: number;
  region: string;
  region_name: string;
  game_biz: string;
}

export interface UserDto {
  id: number;
  aid: string;
  mid: string;
  is_oversea: boolean;
  nickname: string | null;
  uid: string | null;
  avatar: string | null;
  region_name: string | null;
  game_roles: GameRoleDto[];
  cookie_token_updated_at: number;
  fingerprint_updated_at: number;
}

export interface QrCreateDto {
  ticket: string;
  svg: string;
}

export interface QrPollDto {
  status: "Init" | "Scanned" | "Confirmed" | "Expired";
  user: UserDto | null;
}

/** 极验风控参数（触发时需先完成人机验证） */
export interface CaptchaRisk {
  session_id: string;
  gt: string;
  challenge: string;
}

/** 发送验证码结果：已发送 / 触发极验风控 */
export type CaptchaSendDto =
  | { status: "sent"; action_type: string; countdown: number }
  | ({ status: "risk" } & CaptchaRisk);

/** 验证码登录结果：登录成功 / 触发极验风控 */
export type CaptchaLoginDto =
  | { status: "ok"; user: UserDto }
  | ({ status: "risk" } & CaptchaRisk);

/** 我的角色：index + list + detail 三段原始数据（前端组装视图） */
export interface AvatarPropertyDto {
  index: PlayerIndexData;
  list: { list: CharacterListItem[] };
  detail: { list: DetailedCharacter[] };
}

export interface PlayerIndexData {
  stats?: Record<string, number>;
  avatars: IndexAvatar[];
}

export interface IndexAvatar {
  id: number;
  name: string;
  element: string;
  fetter: number;
  level: string;
  rarity: number;
  actived_constellation_num: number;
  image?: string;
  card_image?: string;
  icon?: string;
  side_icon?: string;
}

export interface CharacterListItem {
  id: number;
  name: string;
  element: string;
  fetter: number;
  level: number;
  rarity: number;
  actived_constellation_num: number;
  weapon_type?: string;
  icon?: string;
  side_icon?: string;
  image?: string;
  weapon: { id: number; type: number; rarity: number; level: number; affix_level: number; name?: string; icon?: string };
}

export interface DetailedCharacter {
  base: CharacterListItem;
  weapon: { id: number; type: number; rarity: number; level: number; affix_level: number; name?: string; icon?: string; promote_level?: number };
  relics: Reliquary[];
  constellations: { id: number; name: string; icon: string; effect: string; is_actived: boolean; pos: number }[];
  costumes?: { id: number; icon?: string }[];
  selected_properties: { property_type: number; val: string; base?: string }[];
  base_properties?: { property_type: number; val: string }[];
  skills: CharacterSkill[];
}

/** 技能：skill_type=1 战斗天赋（普攻/E/Q），=2 固有天赋；图标为完整 URL */
export interface CharacterSkill {
  skill_id: number;
  skill_type: number;
  level: number;
  name: string;
  icon: string;
  desc: string;
  skill_affix_list?: { name: string; value: string }[];
}

export interface Reliquary {
  id: number;
  name: string;
  icon: string;
  pos: number;
  rarity: number;
  level: number;
  set: { name: string; effects?: { activation_number: number; effect: string }[] };
  pos_name: string;
  main_property: ReliquaryProperty;
  sub_property_list: ReliquaryProperty[];
}

export interface ReliquaryProperty {
  property_type: number;
  val: string;
}

/** 后端 ApiError 的序列化结构 */
export interface ApiErrorShape {
  code: number;
  message: string;
}

export function isApiError(e: unknown): e is ApiErrorShape {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export function errText(e: unknown): string {
  if (isApiError(e)) {
    return `[${e.code}] ${e.message}`;
  }
  return String(e);
}

const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
};

export const api = {
  listUsers: () => invoke<UserDto[]>("list_users"),

  qrCreate: () => invoke<QrCreateDto>("qr_login_create"),

  qrPoll: (ticket: string) => invoke<QrPollDto>("qr_login_poll", { ticket }),

  captchaSend: (mobile: string, aigis?: string) =>
    invoke<CaptchaSendDto>("mobile_captcha_send", { mobile, aigis: aigis ?? null }),

  captchaLogin: (mobile: string, captcha: string, actionType: string, aigis?: string) =>
    invoke<CaptchaLoginDto>("mobile_captcha_login", { mobile, captcha, actionType, aigis: aigis ?? null }),

  cookieLogin: (raw: string, isOversea: boolean) =>
    invoke<UserDto>("cookie_login", { raw, isOversea }),

  avatarPropertyRefresh: (userId: number, gameUid: string, challenge?: string) =>
    invoke<AvatarPropertyDto>("avatar_property_refresh", { userId, gameUid, challenge: challenge ?? null }),

  removeUser: (id: number) => invoke<void>("remove_user", { id }),

  refreshCookieToken: (id: number) => invoke<UserDto>("refresh_cookie_token", { id }),

  exportUserCookies: (id: number) => invoke<string>("export_user_cookies", { id }),

  // ---- 祈愿记录 ----

  gachaArchives: () => invoke<GachaArchiveDto[]>("gacha_archives"),

  gachaStatistics: (archiveId: number) =>
    invoke<GachaStatisticsDto>("gacha_statistics", { archiveId }),

  gachaRemoveArchive: (archiveId: number) =>
    invoke<void>("gacha_remove_archive", { archiveId }),

  gachaRefreshByStoken: (userId: number, gameUid: string) =>
    invoke<string>("gacha_refresh_by_stoken", { userId, gameUid }),

  gachaRefreshByWebCache: () => invoke<string>("gacha_refresh_by_web_cache"),

  gachaRefreshByManual: (input: string, aggressive: boolean) =>
    invoke<string>("gacha_refresh_by_manual", { input, aggressive }),

  // ---- 实时便签 ----

  dailyNote: (userId: number, gameUid: string, challenge?: string) =>
    invoke<DailyNoteData>("daily_note", { userId, gameUid, challenge: challenge ?? null }),

  cardCreateVerification: (userId: number) =>
    invoke<{ gt: string; challenge: string }>("card_create_verification", { userId }),

  cardVerifyVerification: (userId: number, challenge: string, validate: string) =>
    invoke<string>("card_verify_verification", { userId, challenge, validate }),

  // ---- 周期挑战记录 ----

  /** 本地历史（kind: abyss | theater | hard），返回该玩法全部期快照 */
  chronicleList: <T>(userId: number, gameUid: string, kind: string) =>
    invoke<T[]>("chronicle_list", { userId, gameUid, kind }),

  /** 拉官方数据合并入库，返回合并后全部期 */
  chronicleRefresh: <T>(userId: number, gameUid: string, kind: string, challenge?: string) =>
    invoke<T[]>("chronicle_refresh", { userId, gameUid, kind, challenge: challenge ?? null }),

  // ---- 反馈中心 ----

  /** 打包诊断信息并打开 GitHub Issue 页面，返回 zip 路径与 Issue 链接 */
  feedbackSubmit: (text: string, imagePaths: string[], includeLogs: boolean, includeDumps: boolean) =>
    invoke<FeedbackResult>("feedback_submit", { text, imagePaths, includeLogs, includeDumps }),

  // ---- 更新体系 ----

  /** OSS 版本通告（灰度门控主源，失败时前端回退 GitHub 直查） */
  updateNotice: () => invoke<UpdateNotice>("update_notice"),

  /** 指定版本的更新说明 markdown（OSS 主源，GitHub 兜底） */
  updateNotes: (version: string) => invoke<string>("update_notes", { version }),
};

/** feedback_submit 命令的返回（后端 serde rename_all = camelCase） */
export interface FeedbackResult {
  zipPath: string;
  issueUrl: string;
  dumpCount: number;
  imageCount: number;
  clipboardOk: boolean;
}

/** OSS notice.json（update_notice 命令返回） */
export interface UpdateNotice {
  version: string;
  gray: number;
}

// ---------------------------------------------------------------------------
// 祈愿记录类型（对应后端 gacha_stats.rs）
// ---------------------------------------------------------------------------

export interface GachaArchiveDto {
  id: number;
  uid: string;
}

export interface OrangeEntry {
  name: string;
  item_type: string;
  pull: number;
  time: string;
  /** 是否当期 UP（true=中，false=歪） */
  is_up: boolean;
}

export interface WishSummary {
  name: string;
  total_count: number;
  from_time: string;
  to_time: string;
  total_orange: number;
  total_purple: number;
  total_blue: number;
  orange_percent: number;
  purple_percent: number;
  blue_percent: number;
  last_orange_pull: number;
  last_purple_pull: number;
  guarantee_orange_threshold: number;
  guarantee_purple_threshold: number;
  max_orange_pull: number;
  min_orange_pull: number;
  average_orange_pull: number;
  total_up_orange: number;
  total_lost_orange: number;
  average_up_orange_pull: number;
  /** 当前是否处于大保底 */
  guaranteed: boolean;
  /** 该池是否有 UP 概念 */
  has_up: boolean;
  orange_list: OrangeEntry[];
}

export interface StoredItem {
  id: number;
  gacha_type: number;
  query_type: number;
  item_id: string;
  name: string;
  item_type: string;
  rank_type: number;
  time: string;
  /** 五星是否命中当期 UP */
  is_up: boolean;
}

export interface HistoryGroup {
  items: StoredItem[];
  count: number;
}

export interface PoolHistory {
  query_type: number;
  name: string;
  groups: HistoryGroup[];
}

export interface NameCountEntry {
  name: string;
  item_type: string;
  rank_type: number;
  count: number;
}

export interface GachaStatisticsDto {
  uid: string;
  total_count: number;
  avatar_wish: WishSummary;
  weapon_wish: WishSummary;
  standard_wish: WishSummary;
  chronicled_wish: WishSummary;
  history: PoolHistory[];
  avatars: NameCountEntry[];
  weapons: NameCountEntry[];
}

// ---------------------------------------------------------------------------
// 实时便签类型（对应后端 daily_note.rs，字段与米哈游 JSON 一致）
// ---------------------------------------------------------------------------

export interface DailyNoteExpedition {
  avatar_side_icon: string;
  status: string;
  remained_time: number;
}

export interface DailyNoteData {
  current_resin: number;
  max_resin: number;
  resin_recovery_time: number;
  finished_task_num: number;
  total_task_num: number;
  is_extra_task_reward_received: boolean;
  remain_resin_discount_num: number;
  resin_discount_num_limit: number;
  current_home_coin: number;
  max_home_coin: number;
  home_coin_recovery_time: number;
  current_expedition_num: number;
  max_expedition_num: number;
  expeditions: DailyNoteExpedition[];
  transformer?: {
    obtained: boolean;
    recovery_time?: { day: number; hour: number; minute: number; second: number; reached: boolean };
  };
  daily_task?: {
    total_num: number;
    finished_num: number;
    is_extra_task_reward_received: boolean;
    attendance_visible: boolean;
    stored_attendance: number;
  };
  archon_quest_progress?: {
    list: { status: string; chapter_num: string; chapter_title: string }[];
    is_finish_all_mainline: boolean;
  };
  fetched_at_ms: number;
}

// ---------------------------------------------------------------------------
// 周期挑战记录类型（对应后端 game_record.rs）
// ---------------------------------------------------------------------------

export interface SpiralAbyss {
  schedule_id: number;
  start_time: number;
  end_time: number;
  total_battle_times: number;
  total_win_times: number;
  max_floor: string;
  reveal_rank: RankAvatar[];
  defeat_rank: RankAvatar[];
  damage_rank: RankAvatar[];
  take_damage_rank: RankAvatar[];
  normal_skill_rank: RankAvatar[];
  energy_skill_rank: RankAvatar[];
  floors: AbyssFloor[];
  total_star: number;
  is_unlock: boolean;
  is_just_skipped_floor: boolean;
  skipped_floor: string | null;
}

export interface RankAvatar {
  avatar_icon: string;
  value: number;
  rarity: number;
}

export interface AbyssFloor {
  index: number;
  icon: string;
  is_unlock: boolean;
  settle_time: number;
  star: number;
  max_star: number;
  levels: AbyssLevel[];
  ley_line_disorder: string[] | null;
}

export interface AbyssLevel {
  index: number;
  star: number;
  max_star: number;
  battles: AbyssBattle[];
  top_half_floor_monster: AbyssMonster[] | null;
  bottom_half_floor_monster: AbyssMonster[] | null;
}

export interface AbyssBattle {
  index: number;
  timestamp: number;
  avatars: { icon: string; level: number; rarity: number }[];
}

export interface AbyssMonster {
  name: string;
  icon: string;
  level: number;
}

export interface RoleCombat {
  data: RoleCombatData[];
  is_unlock: boolean;
}

export interface RoleCombatData {
  detail: {
    rounds_data: TheaterRound[];
    detail_stat: TheaterStat | null;
    backup_avatars: TheaterAvatar[];
    fight_statistics: TheaterFightStats;
  };
  stat: TheaterStat;
  schedule: { start_time: number; end_time: number; schedule_id: number };
  has_data: boolean;
  has_detail_data: boolean;
}

export interface TheaterStat {
  difficulty_id: number;
  max_round_id: number;
  heraldry: number;
  get_medal_round_list: number[];
  medal_num: number;
  coin_num: number;
  avatar_bonus_num: number;
  rent_cnt: number;
  tarot_finished_cnt: number;
}

export interface TheaterRound {
  avatars: TheaterAvatar[];
  choice_cards: TheaterBuff[];
  buffs: TheaterBuff[];
  is_get_medal: boolean;
  round_id: number;
  finish_time: number;
  enemies: { name: string; icon: string; level: number }[];
  splendour_buff: {
    summary: { icon: string; name: string; desc: string } | null;
    buffs: { icon: string; name: string; desc: string; level: number }[];
  } | null;
}

export interface TheaterAvatar {
  name: string;
  /** 1=正常 2=试用 3=支援 */
  avatar_type: number;
  image: string;
  level: number;
  rarity: number;
}

export interface TheaterBuff {
  icon: string;
  name: string;
  desc: string;
  is_enhanced: boolean;
}

export interface TheaterFightStats {
  max_defeat_avatar: StatAvatar | null;
  max_damage_avatar: StatAvatar | null;
  max_take_damage_avatar: StatAvatar | null;
  total_coin_consumed: StatAvatar | null;
  shortest_avatar_list: StatAvatar[];
  total_use_time: number;
  is_show_battle_stats: boolean;
}

export interface StatAvatar {
  avatar_icon: string;
  value: string;
  rarity: number;
}

export interface HardChallenge {
  data: HcScheduleData[];
  is_unlock: boolean;
}

export interface HcScheduleData {
  schedule: { schedule_id: number; start_time: number; end_time: number; is_valid: boolean; name: string };
  single: HcEntry;
  mp: HcEntry;
  blings: { name: string; image: string; is_plus: boolean; rarity: number }[];
}

export interface HcEntry {
  best: { difficulty: number; seconds: number; icon: string } | null;
  challenge: HcChallenge[];
  has_data: boolean;
}

export interface HcChallenge {
  name: string;
  second: number;
  teams: { name: string; image: string; level: number; rank: number; rarity: number }[];
  best_avatar: { side_icon: string; dps: number; kind: number }[];
  monster: { name: string; level: number; icon: string; desc: string[]; tags: { description: string }[] };
}
