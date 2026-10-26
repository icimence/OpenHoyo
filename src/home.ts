import { api, errText, type DailyNoteData, type GachaArchiveDto, type GachaStatisticsDto, type HcScheduleData, type HomeFeed, type RoleCombatData, type SpiralAbyss, type UserDto, type WishSummary } from "./api";
import { cachedDailyNote, DAILY_NOTE_TTL, loadDailyNote } from "./daily-note-data";
import { dailyOverviewHtml, transformerText } from "./daily-note-view";
import { escapeHtml as esc } from "./html";
import { abyssSummary, hardSummary, pityValue, progressPercent, remaining, theaterSummary, type CycleSummary } from "./home-model";
import { currentRoleOf, selectRole } from "./role";
import { bindSelect, selectTrigger } from "./select";
import { closeDialog, onDialogCancel, openDialog, toast } from "./ui";
import { isRiskError } from "./verify";
import { iconFallbackAttr, iconSrc } from "./gacha-view-utils";
import { mdToHtml } from "./md";
import changelog from "../CHANGELOG.md?raw";
import { announcementFragment } from "./announcement";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface HomeNavigation { page: string; action?: "import" | "refresh"; archiveUid?: string }
interface Context { user: UserDto | undefined; navigate: (target: HomeNavigation) => void; login: () => void; roleChanged: () => void }
const feedCache = new Map<boolean, {data: HomeFeed; fetched: number}>();
const cycleCache = new Map<string, {data: CycleSummary | undefined; fetched: number}>();
const cycleKinds = ["abyss","theater","hard"] as const;
const cyclePages = ["spiralabyss","rolecombat","hardchallenge"];
const cycleNames = ["深境螺旋","幻想真境剧诗","幽境危战"];
const cycleIcons = ["SpiralAbyss","RoleCombat","HardChallenge"];
const link = (page: string, text = "详情") => `<button class="home-link" data-home-page="${page}">${text}<svg aria-hidden="true"><use href="#i-chevron"/></svg></button>`;
const section = (icon: string, title: string, page: string, body: string, footer: string) => `<section class="home-card"><header class="home-card-header"><img src="/icons/nav/${icon}.png" alt=""/><h3>${title}</h3>${link(page)}</header>${body}<footer class="home-card-footer">${footer}</footer></section>`;
const releaseNotes = [...changelog.matchAll(/^## (v[^\r\n]+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].slice(0,3).map(m => ({title:m[1], body:m[2].trim()}));

export function renderHomePage(content: HTMLElement, context: Context): () => void {
  const { user } = context;
  let role = currentRoleOf(user);
  let alive = true;
  let generation = 0;
  let refreshing = false;
  let note: DailyNoteData | undefined = user && role ? cachedDailyNote(user.id,role.game_uid) : undefined;
  let noteError = "";
  let archives: GachaArchiveDto[] = [];
  let archiveId: number | undefined;
  let stats: GachaStatisticsDto | undefined;
  let statsError = "";
  let statsVersion = 0;
  let pityPage = 0;
  let feed = feedCache.get(user?.is_oversea ?? false)?.data;
  let feedError = "";
  let newsTab = "game";
  const cycles: (CycleSummary | undefined)[] = [undefined,undefined,undefined];
  const cycleErrors = ["","",""];
  content.innerHTML = `<div class="home-page" id="home-page">
    <div class="home-header"><div class="page-header"><h2>主页</h2><p>欢迎回来，${esc(role?.nickname ?? user?.nickname ?? "旅行者")}</p></div><button id="home-refresh"><svg aria-hidden="true"><use href="#i-refresh"/></svg>刷新</button></div>
    <div class="home-toolbar"><div id="home-role"></div><span id="home-updated" role="status">正在加载首页…</span></div>
    <div id="home-account-state"></div>
    <div class="home-top">
      ${section("DailyNote","今日便笺","dailynote",'<div id="home-note" class="home-note"></div>','<span id="home-transformer"></span>')}
      ${section("GachaLog","保底计数","gachalog",'<div class="home-pity-body"><div id="home-archive"></div><div id="home-pity"></div></div>','<span id="home-gacha-time"></span><button class="home-link" id="home-gacha-refresh">刷新记录<svg aria-hidden="true"><use href="#i-refresh"/></svg></button>')}
    </div>
    <div class="home-section-heading"><h3>本期挑战</h3><span>当前游戏角色的挑战进度</span></div>
    <div class="home-cycles">${cycleKinds.map((_,i) => `<button class="home-card home-cycle" data-home-page="${cyclePages[i]}"><span class="home-cycle-name"><img src="/icons/nav/${cycleIcons[i]}.png" alt=""/>${cycleNames[i]}</span><strong id="home-cycle-value-${i}">—</strong><span class="home-cycle-foot" id="home-cycle-foot-${i}">正在读取本期记录…</span><svg aria-hidden="true"><use href="#i-chevron"/></svg></button>`).join("")}</div>
    <div class="home-bottom"><section class="home-card home-pools"><header class="home-card-header"><h3>当期祈愿</h3><span id="home-pool-countdown"></span></header><div id="home-pools"></div><footer class="home-card-footer">${link("gachalog","查看我的祈愿记录")}</footer></section>
    <section class="home-card home-news"><div class="home-news-tabs" role="tablist" aria-label="公告分类"><button id="home-game-tab" data-news="game" role="tab" aria-controls="home-news-list" aria-selected="true">游戏公告</button><button id="home-app-tab" data-news="app" role="tab" aria-controls="home-news-list" aria-selected="false">工具箱动态</button></div><div id="home-news-list" role="tabpanel" aria-labelledby="home-game-tab"></div></section></div>
    <div class="home-shortcuts"><span>快捷入口</span><button data-home-page="avatarproperty"><img src="/icons/nav/AvatarProperty.png" alt=""/>我的角色</button><button id="home-import"><svg aria-hidden="true"><use href="#i-import"/></svg>导入祈愿</button><button id="home-feedback"><svg aria-hidden="true"><use href="#i-setting"/></svg>反馈中心</button></div>
  </div>`;
  const root = content.querySelector<HTMLElement>("#home-page")!;
  const el = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const active = (token = generation) => alive && root.isConnected && token === generation;
  const currentArchiveUid = () => archives.find(a => a.id === archiveId)?.uid;
  const showError = (error: unknown, area: string) => {
    console.warn(`[home] ${area}失败: ${errText(error)}`);
    return isRiskError(error) ? "需要安全验证，请进入详情后验证" : errText(error);
  };

  function renderAccount(): void {
    const account = el("home-account-state");
    account.innerHTML = !user ? '<div class="home-account-hint"><span>登录米游社，查看树脂、每日状态和本期挑战。</span><button class="primary" data-login>登录米游社</button></div>' : !role ? '<div class="home-account-hint">当前账号没有绑定原神角色，可先查看或导入本地祈愿记录。</div>' : "";
    account.querySelector('[data-login]')?.addEventListener("click",context.login);
    const holder = el("home-role");
    if (user && role) {
      const options = user.game_roles.map(r => ({value:r.game_uid,label:`${r.nickname} · ${r.region_name} · ${r.level}级`}));
      holder.innerHTML = selectTrigger("home-role-select",options,role.game_uid);
      bindSelect(holder.querySelector('button')!,options,role.game_uid,uid => {
        console.info("[home] 切换当前角色");
        selectRole(uid); context.roleChanged();
      });
    } else holder.textContent = user ? "尚无游戏角色" : "本地祈愿与游戏资讯";
  }
  function renderNote(): void {
    el("home-note").innerHTML = `${noteError ? `<div class="home-inline-error" role="status">${note ? "显示上次数据 · " : ""}${esc(noteError)}</div>` : ""}${dailyOverviewHtml(note)}`;
    el("home-transformer").textContent = transformerText(note);
    el("home-updated").textContent = note ? `便笺更新于 ${new Date(note.fetched_at_ms).toLocaleTimeString("zh-CN",{hour12:false})}${noteError ? " · 刷新失败" : ""}` : user && role ? "便笺尚未同步" : "";
  }
  function renderPity(): void {
    const entries: [string,WishSummary | undefined][] = pityPage === 0 ? [["角色活动",stats?.avatar_wish],["神铸赋形",stats?.weapon_wish],["奔行世间",stats?.standard_wish]] : [["集录祈愿",stats?.chronicled_wish]];
    el("home-pity").innerHTML = `${statsError ? `<div class="home-inline-error" role="status">${esc(statsError)}</div>` : ""}<div class="home-pity-grid">${entries.map(([name,w]) => `<div class="home-pity-pool"><h4>${name}</h4>${([5,4] as const).map(rank => {
      const v = pityValue(w,rank);
      const max = w ? rank === 5 ? w.guarantee_orange_threshold : w.guarantee_purple_threshold : rank === 5 ? 90 : 10;
      return `<div class="home-pity-meter rank-${rank}" role="meter" aria-label="${name}${rank === 5 ? "五星" : "四星"}保底计数" aria-valuemin="0" aria-valuemax="${max}" ${v !== null ? `aria-valuenow="${v}"` : 'aria-valuetext="暂无可靠记录"'}><span class="home-pity-fill" style="width:${v !== null ? progressPercent(v,max) : 0}%"></span><span>${rank === 5 ? "五星" : "四星"}</span><strong>${v ?? "—"}</strong></div>`;
    }).join("")}</div>`).join("")}</div>${stats?.chronicled_wish.total_count ? `<div class="home-pity-switch"><button data-pity="0" aria-label="角色、武器和常驻祈愿" aria-pressed="${pityPage === 0}"></button><button data-pity="1" aria-label="集录祈愿" aria-pressed="${pityPage === 1}"></button><button class="home-pity-next" data-pity="${pityPage === 0 ? 1 : 0}" aria-label="切换卡池"><svg><use href="#i-chevron"/></svg></button></div>` : ""}${!stats ? '<p class="home-empty-note">暂无祈愿存档，可刷新或导入记录</p>' : stats.total_count > 0 && [stats.avatar_wish,stats.weapon_wish,stats.standard_wish].some(w => w.total_unknown > 0) ? '<p class="home-empty-note">部分记录星级待核对，详情中可查看</p>' : ""}`;
    const latest = stats ? [stats.avatar_wish,stats.weapon_wish,stats.standard_wish,stats.chronicled_wish].map(w => w.to_time).filter(Boolean).sort().at(-1) : undefined;
    el("home-gacha-time").textContent = latest ? `最近记录 ${latest.slice(5,10)}` : "尚无本地记录";
  }
  async function loadStats(token: number): Promise<void> {
    const version = ++statsVersion;
    const latest = () => active(token) && version === statsVersion;
    try {
      const all = await api.gachaArchives();
      if (!latest()) return;
      archives = all;
      // 登录账号的角色必须精确匹配，不能展示其它账号的记录。
      const archive = role ? archives.find(a => a.uid === role!.game_uid) : archives.find(a => a.id === archiveId) ?? archives[0];
      archiveId = archive?.id;
      const data = archive ? await api.gachaStatistics(archive.id) : undefined;
      if (!latest()) return;
      stats = data; statsError = ""; pityPage = 0;
      const holder = el("home-archive");
      if (!role && archives.length) {
        const options = archives.map(a => ({value:String(a.id),label:`UID ${a.uid}`}));
        holder.innerHTML = selectTrigger("home-archive-select",options,String(archiveId));
        bindSelect(holder.querySelector('button')!,options,String(archiveId),value => { archiveId = Number(value); stats = undefined; statsError = ""; renderPity(); console.info("[home] 切换本地祈愿存档"); void loadStats(generation); });
      } else holder.textContent = role ? `UID ${role.game_uid}` : "暂无存档";
      renderPity();
    } catch (error) { if (latest()) { statsError = showError(error,"读取祈愿统计"); renderPity(); } }
  }
  function renderCycles(): void {
    cycles.forEach((data,i) => {
      el(`home-cycle-value-${i}`).textContent = data?.value ?? (user && role ? "尚未同步" : "登录后查看");
      el(`home-cycle-foot-${i}`).textContent = cycleErrors[i] ? data ? "刷新失败 · 显示本地记录" : "进入详情刷新或验证" : data ? remaining(data.end) : "查看本期挑战详情";
      el(`home-cycle-foot-${i}`).title = cycleErrors[i] || data?.caption || "";
    });
  }
  function summarize(i: number, records: unknown[]): CycleSummary | undefined {
    return i === 0 ? abyssSummary(records as SpiralAbyss[]) : i === 1 ? theaterSummary(records as RoleCombatData[]) : hardSummary(records as HcScheduleData[]);
  }
  async function loadRoleData(token: number, force: boolean, interactive: boolean): Promise<void> {
    if (!user || !role) return;
    const uid = role.game_uid;
    if (force || !note || Date.now() - note.fetched_at_ms > DAILY_NOTE_TTL) {
      try { const data = await loadDailyNote(user,uid,interactive); if (!active(token)) return; note = data; noteError = ""; renderNote(); }
      catch (error) { if (!active(token)) return; noteError = showError(error,"刷新便笺"); renderNote(); }
    }
    for (const [i,kind] of cycleKinds.entries()) {
      if (!active(token)) return;
      const key = `${user.id}:${uid}:${kind}`;
      const cached = cycleCache.get(key);
      if (!force && cached && Date.now() - cached.fetched < 10 * 60_000) { cycles[i] = cached.data; renderCycles(); continue; }
      try {
        const local = await api.chronicleList(user.id,uid,kind);
        if (!active(token)) return;
        cycles[i] = summarize(i,local); renderCycles();
        const records = await api.chronicleRefresh(user.id,uid,kind);
        if (!active(token)) return;
        cycles[i] = summarize(i,records); cycleErrors[i] = "";
        cycleCache.set(key,{data:cycles[i],fetched:Date.now()});
      } catch (error) { if (!active(token)) return; cycleErrors[i] = showError(error,`刷新${cycleNames[i]}`); }
      renderCycles();
    }
  }
  function renderFeed(): void {
    const pools = feed?.pools ?? [];
    el("home-pool-countdown").textContent = pools[0] ? remaining(pools[0].end_time) : "";
    const poolColumn = (weapon: boolean) => {
      const items = pools.filter(pool => (pool.gacha_type === 302) === weapon);
      return `<section class="home-pool-column" aria-label="${weapon ? "当期武器祈愿" : "当期角色祈愿"}"><h4>${weapon ? "武器活动 · 神铸赋形" : "角色活动祈愿"}</h4>${items.map(pool => pool.names.map(name => `<div class="home-pool-row"><div class="home-pool-portrait"><img src="${iconSrc(name)}" ${iconFallbackAttr(name)} alt="${esc(name)}" loading="lazy"/></div><div><strong>${esc(name)}</strong><span>${esc(pool.name)} · ${esc(pool.version)}</span></div></div>`).join("")).join("") || '<div class="home-content-empty">暂无当期信息</div>'}</section>`;
    };
    el("home-pools").innerHTML = pools.length ? `<div class="home-pool-columns">${poolColumn(false)}${poolColumn(true)}</div>` : `<div class="home-content-empty">${user?.is_oversea ? "国际服活动请以游戏内公告为准" : feed ? "当前暂无可用卡池信息" : feedError ? "卡池信息暂时不可用" : "正在加载当期祈愿…"}</div>`;
    renderNews();
  }
  function renderNews(): void {
    root.querySelectorAll<HTMLButtonElement>('[data-news]').forEach(btn => btn.setAttribute("aria-selected",String(btn.dataset.news === newsTab)));
    const list = el("home-news-list");
    list.setAttribute("aria-labelledby",newsTab === "game" ? "home-game-tab" : "home-app-tab");
    list.innerHTML = newsTab === "app" ? releaseNotes.map((n,i) => `<button class="home-news-row" data-release="${i}"><span class="home-news-tag">更新</span><span>${esc(n.title)} 更新说明</span><svg aria-hidden="true"><use href="#i-chevron"/></svg></button>`).join("") || '<div class="home-content-empty">暂无更新说明</div>' : feed?.announcements.length ? feed.announcements.slice(0,3).map(n => `<button class="home-news-row" data-announcement="${esc(n.id)}"><span class="home-news-tag">${esc(n.category)}</span><span>${esc(n.title)}</span><time>${esc(n.date.slice(5,10))}</time></button>`).join("") : `<div class="home-content-empty">${feed?.announcement_error || feedError ? '公告加载失败 <button class="home-link" data-feed-retry>重试</button>' : feed ? "暂无游戏公告" : "正在加载游戏公告…"}</div>`;
    if (newsTab === "game" && feedError && feed?.announcements.length) list.insertAdjacentHTML("afterbegin",'<div class="home-inline-error" role="status">公告刷新失败，显示上次内容</div>');
  }
  async function loadFeed(force: boolean): Promise<void> {
    const oversea = user?.is_oversea ?? false;
    const cached = feedCache.get(oversea);
    if (!force && cached && !cached.data.announcement_error && Date.now() - cached.fetched < 10 * 60_000) return;
    try {
      const data = await api.homeFeed(oversea);
      if (!active()) return;
      // 公开资讯刷新失败时保留已有公告，错误仍明确提示。
      if (data.announcement_error && feed?.announcements.length) data.announcements = feed.announcements;
      feed = data; feedError = data.announcement_error ? showError(data.announcement_error,"加载公告") : "";
      feedCache.set(oversea,{data,fetched:Date.now()}); renderFeed();
    } catch (error) { if (active()) { feedError = showError(error,"加载公开资讯"); renderFeed(); } }
  }
  async function refresh(force: boolean): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    const token = ++generation;
    const btn = el("home-refresh") as HTMLButtonElement;
    btn.disabled = true;
    console.info(`[home] ${force ? "手动刷新" : "加载首页"}`);
    try { await Promise.allSettled([loadStats(token),loadRoleData(token,force,force),loadFeed(force)]); }
    finally { if (active(token)) { refreshing = false; btn.disabled = false; console.info("[home] 首页加载完成"); } }
  }
  root.addEventListener("click",event => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!btn) return;
    if (btn.dataset.homePage) context.navigate({page:btn.dataset.homePage,archiveUid:currentArchiveUid()});
    else if (btn.id === "home-refresh") void refresh(true);
    else if (btn.id === "home-gacha-refresh") context.navigate({page:"gachalog",action:"refresh",archiveUid:currentArchiveUid()});
    else if (btn.id === "home-import") context.navigate({page:"gachalog",action:"import",archiveUid:currentArchiveUid()});
    else if (btn.id === "home-feedback") { localStorage.setItem("hoyo-settings-tab","feedback"); context.navigate({page:"setting"}); }
    else if (btn.dataset.pity) { pityPage = Number(btn.dataset.pity); renderPity(); }
    else if (btn.dataset.news) { newsTab = btn.dataset.news; renderNews(); }
    else if (btn.hasAttribute("data-feed-retry")) { btn.disabled = true; void loadFeed(true); }
    else if (btn.dataset.release !== undefined) {
      const release = releaseNotes[Number(btn.dataset.release)];
      if (release) { openDialog(esc(release.title),`<div class="changelog-body">${mdToHtml(release.body)}</div>`,null); onDialogCancel(closeDialog); }
    } else if (btn.dataset.announcement) {
      const announcement = feed?.announcements.find(a => a.id === btn.dataset.announcement); if (!announcement) return;
      btn.disabled = true;
      void api.homeAnnouncement(user?.is_oversea ?? false,announcement.id).then(html => {
        if (!active()) return;
        const fragment = announcementFragment(html);
        openDialog(esc(announcement.title),'<article class="home-announcement-body" aria-label="公告正文"></article>',null);
        const article = document.querySelector<HTMLElement>(".home-announcement-body")!;
        article.replaceChildren(fragment);
        document.getElementById("dialog")!.classList.add("home-announcement-dialog");
        if (!article.textContent?.trim() && !article.querySelector("img")) article.textContent = "暂无正文";
        article.addEventListener("click", event => {
          const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
          if (!anchor) return;
          event.preventDefault();
          console.info("[home] 打开公告外部链接");
          void openUrl(anchor.href).catch(error => { console.warn(`[home] 公告链接打开失败: ${errText(error)}`); toast("无法打开公告链接，请稍后重试","error"); });
        });
        console.info(`[home] 公告图文已显示（图片=${article.querySelectorAll("img").length}）`);
        document.getElementById("dialog-cancel")!.textContent = "关闭";
        onDialogCancel(closeDialog);
      }).catch(error => { console.warn(`[home] 打开公告失败: ${errText(error)}`); toast(errText(error),"error"); }).finally(() => { btn.disabled = false; });
    }
  });
  renderAccount(); renderNote(); renderPity(); renderCycles(); renderFeed();
  void refresh(false);
  const timer = window.setInterval(() => { if (active() && !refreshing) void refresh(false); },DAILY_NOTE_TTL);
  return () => { alive = false; generation++; window.clearInterval(timer); };
}
