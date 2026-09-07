// 实时便签（对应原版 DailyNotePage.xaml + DailyNoteCard）：进度条卡片布局，
// 顶栏手动刷新 + 页面停留期间 8 分钟自动刷新 + 30 秒倒计时走针。
// 遇 1034/5003 账号风控时自动走安全验证（共享 verify.ts）。
import { api, errText, isApiError, type DailyNoteData, type UserDto } from "./api";
import { toast } from "./ui";
import { abandonActiveGeetest, fetchWithVerification } from "./verify";

/** 每个角色的最新快照（uid -> data），供倒计时走针就地刷新 */
const snapshots = new Map<string, DailyNoteData>();
/** 每个角色的最近错误（uid -> 展示信息），随快照一起参与卡片渲染，避免重渲染丢失 */
const errors = new Map<string, { text: string; needVerify: boolean }>();
let ticker: number | undefined;
let autoRefresh: number | undefined;

/** 单飞守卫：同一时刻只允许一轮刷新/验证流程 */
let refreshing = false;

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** 目标时刻显示：<24h 只显时刻，否则带日期（对应原版 Resin/HomeCoin RecoveryTargetTime） */
function targetTime(ms: number): string {
  if (ms <= 0) {
    return "已恢复完成";
  }
  const d = new Date(ms);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 剩余时间："X小时Y分" / "Y分" */
function remainText(sec: number): string {
  if (sec <= 0) {
    return "已完成";
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}小时${m}分` : `${m}分`;
}

/** 中文章节数字 → 序号（魔神任务进度条近似：已完成章数/总章数） */
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function chapterIndex(chapterNum: string): number {
  const m = chapterNum.match(/第([一二三四五六七八九十]+)章/);
  if (!m) {
    return 0;
  }
  const s = m[1];
  if (s === "十") return 10;
  if (s.startsWith("十")) return 10 + (CN_NUM[s[1]] ?? 0);
  return CN_NUM[s] ?? 0;
}

function rowHtml(
  icon: string,
  title: string,
  caption: string,
  value: number,
  max: number,
  extra = "",
): string {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  // icon 以 "/" 开头时是本地米哈游原版图标（public/icons），否则是内联 SVG symbol
  const iconHtml = icon.startsWith("/")
    ? `<img class="dn-row-icon" src="${icon}" alt="" onerror="this.remove()"/>`
    : `<svg class="dn-row-icon"><use href="#${icon}"/></svg>`;
  return `
  <div class="dn-row">
    <div class="dn-row-bar" style="width:${pct}%"></div>
    ${iconHtml}
    <div class="dn-row-text">
      <div class="dn-row-title">${title}</div>
      <div class="dn-row-caption">${caption}</div>
    </div>
    ${extra}
  </div>`;
}

/** 加载骨架：与真实卡片同结构的 shimmer 占位（对应原版 Skeleton 加载态） */
function skeletonRows(): string {
  const row = `
  <div class="dn-row sk">
    <div class="sk-bar sk-icon"></div>
    <div class="sk-lines">
      <div class="sk-bar sk-line-title"></div>
      <div class="sk-bar sk-line-cap"></div>
    </div>
  </div>`;
  const exp = `
  <div class="dn-exp sk">
    <div class="sk-bar sk-avatar"></div>
    <div class="sk-bar sk-text"></div>
  </div>`;
  return `${row.repeat(5)}<div class="dn-exp-grid">${exp.repeat(4)}</div>`;
}

function cardHtml(
  uid: string,
  role: { nickname: string; region_name: string },
  data: DailyNoteData | undefined,
  error: { text: string; needVerify: boolean } | undefined,
  loading = false,
): string {
  const fetched = data
    ? `数据更新于 ${new Date(data.fetched_at_ms).toLocaleTimeString("zh-CN", { hour12: false })}`
    : loading
      ? "加载中…"
      : "尚未刷新";

  // 魔神任务：无元数据，按章节序号近似进度
  const quests = data?.archon_quest_progress?.list ?? [];
  let archonTitle = "魔神任务";
  let archonCaption = "已全部完成";
  let archonValue = 1;
  let archonMax = 1;
  if (quests.length > 0) {
    const q = quests[0];
    const idx = chapterIndex(q.chapter_num);
    archonTitle = "魔神任务 · 进行中";
    archonCaption = `${q.chapter_num} ${esc(q.chapter_title)}`;
    archonValue = idx;
    archonMax = Math.max(idx + 1, 1);
  }

  const resinFullAt = data ? data.fetched_at_ms + data.resin_recovery_time * 1000 : 0;
  const coinFullAt = data ? data.fetched_at_ms + data.home_coin_recovery_time * 1000 : 0;

  // 每日委托：优先新版 daily_task，回退顶层字段
  const taskTotal = data?.daily_task && data.daily_task.total_num > 0 ? data.daily_task.total_num : (data?.total_task_num ?? 0);
  const taskDone = data?.daily_task && data.daily_task.total_num > 0 ? data.daily_task.finished_num : (data?.finished_task_num ?? 0);
  const taskRewardTaken = data?.daily_task?.is_extra_task_reward_received ?? data?.is_extra_task_reward_received ?? false;
  const taskCaption = taskRewardTaken
    ? "奖励已领取"
    : taskDone === taskTotal && taskTotal > 0
      ? "奖励待领取"
      : "完成委托后可在凯瑟琳处领取额外奖励";

  // 周本：已用/上限
  const discountUsed = (data?.resin_discount_num_limit ?? 0) - (data?.remain_resin_discount_num ?? 0);

  // 参量质变仪
  let trTitle = "参量质变仪";
  let trCaption = "未获得";
  let trValue = 0;
  let trMax = 604800;
  if (data?.transformer?.obtained) {
    const rt = data.transformer.recovery_time;
    if (rt?.reached) {
      trTitle = "参量质变仪 · 已就绪";
      trCaption = "可使用";
      trValue = 604800;
    } else if (rt) {
      trTitle = "参量质变仪";
      trCaption = `${rt.day > 0 ? `${rt.day}天` : ""}${rt.hour}小时${rt.minute}分后可使用`;
      const used = 604800 - (rt.second + rt.minute * 60 + rt.hour * 3600 + rt.day * 86400);
      trValue = Math.max(0, used);
    }
  }

  const exps = (data?.expeditions ?? []).map((e) => {
    const done = e.status === "Finished" || e.remained_time <= 0;
    const remain = Math.max(0, e.remained_time - Math.floor((Date.now() - (data?.fetched_at_ms ?? Date.now())) / 1000));
    return `
    <div class="dn-exp ${done ? "done" : ""}">
      <img src="${esc(e.avatar_side_icon)}" onerror="this.style.visibility='hidden'"/>
      <span>${done ? "已完成" : remainText(remain)}</span>
    </div>`;
  }).join("");

  const rows = !data
    ? error
      ? `<div class="dn-error">${esc(error.text)}${error.needVerify ? `<br/><button class="dn-verify" data-uid="${esc(uid)}">安全验证</button>` : ""}</div>`
      : loading
        ? skeletonRows()
        : '<div class="dn-error">尚未刷新</div>'
    : `
    ${rowHtml("i-dn-quest", archonTitle, archonCaption, archonValue, archonMax)}
    ${rowHtml("/icons/ui/UI_ItemIcon_106.png", `${data.current_resin}/${data.max_resin}`, `预计 <span data-cd-target="${resinFullAt}">${targetTime(resinFullAt - Date.now() <= 0 ? 0 : resinFullAt)}</span> 全部恢复`, data.current_resin, data.max_resin)}
    ${rowHtml("/icons/ui/UI_ItemIcon_204.png", data.max_home_coin === 0 ? "未解锁" : `${data.current_home_coin}/${data.max_home_coin}`, data.max_home_coin === 0 ? "尚未开启尘歌壶系统" : `预计 <span data-cd-target="${coinFullAt}">${targetTime(coinFullAt - Date.now() <= 0 ? 0 : coinFullAt)}</span> 全部恢复`, data.current_home_coin, data.max_home_coin)}
    ${rowHtml("i-dn-task", `${taskDone}/${taskTotal}`, taskCaption, taskDone, taskTotal)}
    ${rowHtml("i-dn-weekly", `${discountUsed}/${data.resin_discount_num_limit}`, "今日已用周本减免次数", discountUsed, data.resin_discount_num_limit)}
    ${rowHtml("/icons/ui/UI_ItemIcon_220021.png", trTitle, trCaption, trValue, trMax)}
    ${exps ? `<div class="dn-exp-grid">${exps}</div>` : ""}`;

  return `
  <div class="dn-card" data-uid="${esc(uid)}">
    <div class="dn-card-header">
      <span class="dn-role">${esc(role.nickname)} · ${esc(uid)} · ${esc(role.region_name)}</span>
      <span class="dn-refreshed">${fetched}</span>
    </div>
    <div class="dn-card-body">${rows}</div>
  </div>`;
}

/** 30 秒走针：只更新目标时刻文本（树脂/宝钱恢复时间随时间推移变为"已恢复完成"） */
function startTicker(): void {
  window.clearInterval(ticker);
  ticker = window.setInterval(() => {
    if (!document.getElementById("dn-root")) {
      window.clearInterval(ticker);
      ticker = undefined;
      return;
    }
    document.querySelectorAll<HTMLElement>("#dn-root [data-cd-target]").forEach((el) => {
      const target = Number(el.dataset.cdTarget);
      el.textContent = targetTime(target - Date.now() <= 0 ? 0 : target);
    });
  }, 30_000);
}

export function renderDailyNotePage(content: HTMLElement, currentUser: UserDto | undefined): void {
  if (!currentUser) {
    content.innerHTML = `
      <div class="page-header"><h2>实时便签</h2><p>树脂、委托、派遣等游戏内实时数据</p></div>
      <div class="placeholder-page"><div class="placeholder-card">
        <svg><use href="#i-unimplemented"/></svg>
        <div class="title">尚未登录</div>
        <div class="desc">通过左下角用户菜单登录后再来查看实时便签</div>
      </div></div>`;
    return;
  }

  const roles = currentUser.game_roles;

  // 页面重渲染（切换页签/HMR）时放弃上一轮未完成的验证流程并复位单飞守卫
  abandonActiveGeetest();
  refreshing = false;

  content.innerHTML = `
    <div class="page-header"><h2>实时便签</h2><p>树脂、委托、派遣等游戏内实时数据</p></div>
    <div class="dn-toolbar">
      <button class="primary" id="dn-refresh"><svg><use href="#i-refresh"/></svg>刷新数据</button>
      <span class="dn-hint">页面停留期间每 8 分钟自动刷新</span>
    </div>
    <div id="dn-root" class="dn-grid">
      ${roles
        .map((r) => cardHtml(r.game_uid, r, snapshots.get(r.game_uid), errors.get(r.game_uid), !snapshots.has(r.game_uid) && !errors.has(r.game_uid)))
        .join("")}
    </div>`;

  const root = document.getElementById("dn-root")!;
  const refreshBtn = document.getElementById("dn-refresh") as HTMLButtonElement;

  /** pending=true 时无数据且无错误的卡片渲染为骨架屏（刷新进行中） */
  function renderCards(pending: boolean): void {
    root.innerHTML = roles
      .map((r) => {
        const data = snapshots.get(r.game_uid);
        const err = errors.get(r.game_uid);
        return cardHtml(r.game_uid, r, data, err, pending && !data && !err);
      })
      .join("");
    // 风控错误卡片上的"安全验证"入口
    root.querySelectorAll<HTMLButtonElement>(".dn-verify").forEach((btn) => {
      btn.addEventListener("click", () => {
        void (async () => {
          btn.disabled = true;
          try {
            snapshots.set(
              btn.dataset.uid!,
              await fetchWithVerification(currentUser!.id, (ch) => api.dailyNote(currentUser!.id, btn.dataset.uid!, ch)),
            );
            errors.delete(btn.dataset.uid!);
            renderCards(false);
          } catch (e2) {
            toast(`安全验证后仍失败: ${errText(e2)}`, "error");
            btn.disabled = false;
          }
        })();
      });
    });
  }

  /**
   * @param interactive true=命中风控时自动弹出安全验证（进入页面/手动刷新）
   *                  false=定时自动刷新：不弹验证码，错误卡片提供验证按钮
   */
  async function refresh(interactive: boolean): Promise<void> {
    if (refreshing) {
      return;
    }
    refreshing = true;
    refreshBtn.disabled = true;
    console.info(`[dailynote] 刷新实时便签（${roles.length} 个角色，${interactive ? "手动含验证" : "自动"}）`);
    try {
      for (const role of roles) {
        try {
          const data = interactive
            ? await fetchWithVerification(currentUser!.id, (ch) => api.dailyNote(currentUser!.id, role.game_uid, ch))
            : await api.dailyNote(currentUser!.id, role.game_uid);
          snapshots.set(role.game_uid, data);
          errors.delete(role.game_uid);
        } catch (e) {
          // 单个角色失败不影响其它角色卡片；错误状态入映射，随卡片一起渲染
          const needVerify = isApiError(e) && (e.code === 1034 || e.code === 5003);
          errors.set(role.game_uid, { text: errText(e), needVerify });
          if (!needVerify && roles.length === 1) {
            toast(`实时便签刷新失败: ${errText(e)}`, "error");
          }
        }
        // 每完成一个角色即重渲染：已完成的展示数据，未完成的保持骨架屏
        renderCards(true);
      }
      renderCards(false);
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener("click", () => {
    void refresh(true);
  });

  window.clearInterval(autoRefresh);
  autoRefresh = window.setInterval(() => {
    if (!document.getElementById("dn-root")) {
      window.clearInterval(autoRefresh);
      autoRefresh = undefined;
      return;
    }
    void refresh(false);
  }, 8 * 60 * 1000);

  startTicker();
  // 进入页面即拉取；被风控拦截时直接弹出安全验证，无需再点"安全验证"按钮
  void refresh(true);
}
