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

export interface CaptchaSendDto {
  action_type: string;
  countdown: number;
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

  captchaSend: (mobile: string) => invoke<CaptchaSendDto>("mobile_captcha_send", { mobile }),

  captchaLogin: (mobile: string, captcha: string, actionType: string) =>
    invoke<UserDto>("mobile_captcha_login", { mobile, captcha, actionType }),

  cookieLogin: (raw: string, isOversea: boolean) =>
    invoke<UserDto>("cookie_login", { raw, isOversea }),

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
};

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
