import "./style.css";
import { api, errText, type UserDto } from "./api";
import { renderGachaPage } from "./gacha";
import {
  closeDialog,
  onDialogCancel,
  onDialogOk,
  openDialog,
  runWithOkGuard,
  setOkEnabled,
  setStatus,
  toast,
} from "./ui";
import { checkForUpdates, initUpdateBadge } from "./updater";
import { initTheme, renderSettingsPage } from "./settings";
import { renderDailyNotePage } from "./dailynote";

// ---------------------------------------------------------------------------
// 导航定义（对应原版 MainView.xaml 的 NavigationView 项与分组）
// ---------------------------------------------------------------------------

interface NavItem {
  id: string;
  label: string;
  icon: string;
  group?: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "user", label: "用户", icon: "i-user" },
  { id: "announcement", label: "主页", icon: "i-home" },
  { id: "gachalog", label: "祈愿记录", icon: "i-gacha", group: "工具" },
  { id: "achievement", label: "成就管理", icon: "i-achievement", group: "工具" },
  { id: "dailynote", label: "实时便笺", icon: "i-dailynote", group: "工具" },
  { id: "avatarproperty", label: "我的角色", icon: "i-avatarprop", group: "工具" },
  { id: "cultivation", label: "养成计划", icon: "i-cultivation", group: "工具" },
  { id: "spiralabyss", label: "深境螺旋", icon: "i-abyss", group: "周期" },
  { id: "rolecombat", label: "幻想真境剧诗", icon: "i-rolecombat", group: "周期" },
  { id: "hardchallenge", label: "幽境危战", icon: "i-hardchallenge", group: "周期" },
  { id: "setting", label: "设置", icon: "i-setting" },
];

let currentPage = "user";
let users: UserDto[] = [];
let currentUserId: number | null = null;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatTime(ms: number): string {
  if (ms <= 0) {
    return "从未刷新";
  }
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function currentUser(): UserDto | undefined {
  return users.find((u) => u.id === currentUserId) ?? users[0];
}

function avatarHtml(u: UserDto, mini = false): string {
  const cls = mini ? "mini-avatar" : "avatar";
  const initial = esc((u.nickname ?? u.mid).slice(0, 1).toUpperCase());
  if (u.avatar) {
    return `<div class="${cls}">${initial}<img src="${esc(u.avatar)}" onerror="this.remove()"/></div>`;
  }
  return `<div class="${cls}">${initial}</div>`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------------------------------------------------------------------------
// 侧边栏渲染与路由
// ---------------------------------------------------------------------------

function renderNav(): void {
  const holder = document.getElementById("nav-items")!;
  const html: string[] = [];
  let lastGroup: string | undefined;
  const implemented = new Set(["user", "gachalog", "setting", "dailynote"]);
  for (const item of NAV_ITEMS) {
    if (item.group && item.group !== lastGroup) {
      html.push(`<div class="nav-group-header">${esc(item.group)}</div>`);
    }
    lastGroup = item.group;
    html.push(
      `<button class="nav-item ${item.id === currentPage ? "active" : ""} ${implemented.has(item.id) ? "" : "disabled"}" data-page="${item.id}">` +
        `<svg><use href="#${item.icon}"/></svg><span>${esc(item.label)}</span></button>`,
    );
  }
  holder.innerHTML = html.join("");

  holder.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPage = btn.dataset.page!;
      renderNav();
      renderPage();
    });
  });
}

function renderPage(): void {
  const content = document.getElementById("content")!;
  if (currentPage === "user") {
    renderUserPage(content);
  } else if (currentPage === "gachalog") {
    const cur = currentUser();
    renderGachaPage(content, {
      currentUser: cur
        ? {
            id: cur.id,
            isOversea: cur.is_oversea,
            gameUid: cur.is_oversea ? null : (cur.game_roles.find((r) => r.game_biz.includes("hk4e_cn")) ?? cur.game_roles[0])?.game_uid ?? null,
          }
        : null,
    });
  } else if (currentPage === "setting") {
    void renderSettingsPage(content);
  } else if (currentPage === "dailynote") {
    renderDailyNotePage(content, currentUser());
  } else {
    const item = NAV_ITEMS.find((n) => n.id === currentPage)!;
    content.innerHTML = `
      <div class="placeholder-page">
        <div class="placeholder-card">
          <svg><use href="#i-unimplemented"/></svg>
          <div class="title">${esc(item.label)} · 未实现</div>
          <div class="desc">本复刻版已实现：用户登录 · 祈愿记录</div>
        </div>
      </div>`;
  }
}

// ---------------------------------------------------------------------------
// 用户页（唯一已实现的页面）
// ---------------------------------------------------------------------------

function renderUserPage(content: HTMLElement): void {
  if (users.length === 0) {
    content.innerHTML = `
      <div class="page-header"><h2>用户</h2><p>管理米哈游账号与登录凭证</p></div>
      <div class="empty-users">
        <svg viewBox="0 0 16 16"><use href="#i-user"/></svg>
        <div class="title">尚未登录</div>
        <div class="hint">通过左下角的用户菜单，或以下入口添加账号</div>
        <div class="entry">
          <button class="primary" id="empty-qr"><svg><use href="#i-qr"/></svg>扫码登录</button>
          <button id="empty-captcha"><svg><use href="#i-phone"/></svg>手机验证码</button>
          <button id="empty-cookie"><svg><use href="#i-keyboard"/></svg>手动输入</button>
        </div>
      </div>`;
    document.getElementById("empty-qr")!.addEventListener("click", openQrDialog);
    document.getElementById("empty-captcha")!.addEventListener("click", openCaptchaDialog);
    document.getElementById("empty-cookie")!.addEventListener("click", () => openCookieDialog(false));
    return;
  }

  const cards = users
    .map(
      (u) => `
      <div class="user-card">
        ${avatarHtml(u)}
        <div class="body">
          <div class="row-1">
            <span class="nickname">${esc(u.nickname ?? "未知昵称")}</span>
            <span class="badge ${u.is_oversea ? "os" : "cn"}">${u.is_oversea ? "HoYoLAB" : "米游社"}</span>
            ${u.id === currentUserId ? '<span class="badge">当前</span>' : ""}
          </div>
          <div class="roles">${
            u.game_roles
              .map((r) => `${esc(r.nickname)}<span class="uid">${esc(r.game_uid)}</span> · ${esc(r.region_name)} · Lv.${r.level}`)
              .join("<br/>") || "无游戏角色"
          }</div>
          <div class="meta">cookie_token 刷新于 ${formatTime(u.cookie_token_updated_at)}</div>
        </div>
        <div class="actions">
          <button class="icon-btn" data-act="copy" data-id="${u.id}" title="复制 Cookie"><svg><use href="#i-copy"/></svg></button>
          <button class="icon-btn" data-act="refresh" data-id="${u.id}" title="刷新 Cookie"><svg><use href="#i-refresh"/></svg></button>
          <button class="icon-btn danger" data-act="remove" data-id="${u.id}" title="移除用户"><svg><use href="#i-delete"/></svg></button>
        </div>
      </div>`,
    )
    .join("");

  content.innerHTML = `
    <div class="page-header"><h2>用户</h2><p>共 ${users.length} 个账号，点击左下角用户菜单可添加更多账号</p></div>
    <div class="user-grid">${cards}</div>`;

  content.querySelectorAll<HTMLButtonElement>(".icon-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      void handleCardAction(btn.dataset.act!, Number(btn.dataset.id), btn);
    });
  });
}

async function handleCardAction(act: string, id: number, btn?: HTMLButtonElement): Promise<void> {
  const u = users.find((x) => x.id === id);
  if (!u) {
    return;
  }
  try {
    if (act === "copy") {
      const cookie = await api.exportUserCookies(id);
      await copyText(cookie);
      toast(`已复制 ${u.nickname ?? u.mid} 的 Cookie`, "success");
    } else if (act === "refresh") {
      if (btn) {
        btn.disabled = true;
      }
      await api.refreshCookieToken(id);
      toast("刷新 CookieToken 成功", "success");
      await reload();
    } else if (act === "remove") {
      await api.removeUser(id);
      if (currentUserId === id) {
        currentUserId = null;
      }
      toast("已移除用户", "success");
      await reload();
    }
  } catch (e) {
    toast(errText(e), "error");
    if (btn) {
      btn.disabled = false;
    }
  }
}

// ---------------------------------------------------------------------------
// 左下角用户菜单（对应原版 UserView 的 Flyout 结构与文案）
// ---------------------------------------------------------------------------

function renderFooterUser(): void {
  const cur = currentUser();
  const nickEl = document.getElementById("footer-nickname")!;
  const avatarEl = document.getElementById("footer-avatar")!;

  if (cur) {
    nickEl.textContent = cur.nickname ?? "未知昵称";
    const initial = esc((cur.nickname ?? cur.mid).slice(0, 1).toUpperCase());
    avatarEl.innerHTML = cur.avatar
      ? `${initial}<img src="${esc(cur.avatar)}" onerror="this.remove()"/>`
      : initial;
  } else {
    nickEl.textContent = "尚未登录";
    avatarEl.textContent = "-";
  }
}

function renderUserFlyout(): void {
  const flyout = document.getElementById("user-flyout")!;
  const cur = currentUser();

  // ---- 左栏：品牌登录入口（二级展开）+ 当前用户操作 ----
  const left = `
    <div class="flyout-left">
      <button class="flyout-item flyout-brand" data-expand="sub-cn">
        <span class="brand-logo brand-cn">米</span>米游社<svg class="chevron sub-chev"><use href="#i-chevron"/></svg>
      </button>
      <div class="flyout-sub hidden" id="sub-cn">
        <button class="flyout-item" data-login="qr"><svg><use href="#i-qr"/></svg>扫码登录</button>
        <button class="flyout-item" data-login="captcha"><svg><use href="#i-phone"/></svg>手机验证码</button>
        <button class="flyout-item" data-login="cookie-cn"><svg><use href="#i-keyboard"/></svg>手动输入</button>
      </div>
      <button class="flyout-item flyout-brand" data-expand="sub-os">
        <span class="brand-logo brand-os">H</span>HoYoLAB<svg class="chevron sub-chev"><use href="#i-chevron"/></svg>
      </button>
      <div class="flyout-sub hidden" id="sub-os">
        <button class="flyout-item" data-login="cookie-os"><svg><use href="#i-keyboard"/></svg>手动输入</button>
      </div>
      <div class="flyout-sep"></div>
      <div class="flyout-section center">当前用户</div>
      <button class="flyout-item" data-unimpl="旅行工具"><svg><use href="#i-launch"/></svg>旅行工具</button>
      <button class="flyout-item" data-check-update><svg><use href="#i-refresh"/></svg>检查更新</button>
      <button class="flyout-item" data-act="refresh" ${cur ? "" : "disabled"}><svg><use href="#i-refresh"/></svg>刷新 Cookie</button>
    </div>`;

  // ---- 右栏：未登录显示提示，已登录显示角色 + 用户列表 ----
  let right: string;
  if (!cur) {
    right = `<div class="flyout-right"><div class="flyout-empty">请先登录</div></div>`;
  } else {
    const roleRows = cur.game_roles
      .map(
        (r) => `
        <div class="role-row" data-role="${esc(r.game_uid)}">
          <div class="role-avatar">${esc(r.nickname.slice(0, 1))}</div>
          <div class="role-text">
            <div class="role-name">${esc(r.nickname)}</div>
            <div class="role-desc">${esc(r.game_uid)} · ${esc(r.region_name)} · Lv.${r.level}</div>
          </div>
        </div>`,
      )
      .join("");

    const userRows = users
      .map(
        (u) => `
        <div class="flyout-user-row ${u.id === currentUserId ? "current" : ""}" data-id="${u.id}">
          ${avatarHtml(u, true)}
          <span class="name">${esc(u.nickname ?? u.mid)}</span>
          ${u.is_oversea ? '<span class="badge">HoYoLAB</span>' : ""}
          <span class="row-btns">
            <button data-act="copy" data-id="${u.id}" title="复制 Cookie"><svg><use href="#i-copy"/></svg></button>
            <button data-act="remove" data-id="${u.id}" title="移除用户"><svg><use href="#i-delete"/></svg></button>
          </span>
        </div>`,
      )
      .join("");

    right = `
      <div class="flyout-right">
        ${cur.game_roles.length > 0 ? `<div class="flyout-section">角色</div>${roleRows}<div class="flyout-sep"></div>` : ""}
        <div class="flyout-section">用户</div>
        ${userRows}
      </div>`;
  }

  flyout.innerHTML = `<div class="flyout-cols">${left}${right}</div>`;

  // 品牌入口：展开/收起二级菜单
  flyout.querySelectorAll<HTMLButtonElement>("[data-expand]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sub = flyout.querySelector<HTMLDivElement>(`#${btn.dataset.expand!}`)!;
      sub.classList.toggle("hidden");
      btn.querySelector(".sub-chev")!.classList.toggle("open");
    });
  });

  // 登录入口
  flyout.querySelectorAll<HTMLButtonElement>("[data-login]").forEach((btn) => {
    btn.addEventListener("click", () => {
      hideFlyout();
      const kind = btn.dataset.login!;
      if (kind === "qr") {
        openQrDialog();
      } else if (kind === "captcha") {
        openCaptchaDialog();
      } else {
        openCookieDialog(kind === "cookie-os");
      }
    });
  });

  // 未实现入口（旅行工具）
  flyout.querySelectorAll<HTMLButtonElement>("[data-unimpl]").forEach((btn) => {
    btn.addEventListener("click", () => {
      hideFlyout();
      toast(`${btn.dataset.unimpl!} · 未实现`, "info");
    });
  });

  // 检查更新
  flyout.querySelector<HTMLButtonElement>("[data-check-update]")?.addEventListener("click", () => {
    hideFlyout();
    void checkForUpdates(false);
  });

  // 刷新 Cookie（当前用户）
  flyout.querySelector<HTMLButtonElement>('[data-act="refresh"]')?.addEventListener("click", () => {
    if (!cur) {
      return;
    }
    hideFlyout();
    void handleCardAction("refresh", cur.id);
  });

  // 用户行悬停按钮：复制/移除
  flyout.querySelectorAll<HTMLButtonElement>(".row-btns button").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void handleCardAction(btn.dataset.act!, Number(btn.dataset.id!), btn);
    });
  });

  // 用户行点击：切换当前用户
  flyout.querySelectorAll<HTMLElement>(".flyout-user-row").forEach((row) => {
    row.addEventListener("click", () => {
      currentUserId = Number(row.dataset.id);
      renderUserFlyout();
      renderFooterUser();
      renderPage();
    });
  });

  // 角色行点击：切换选中角色（视觉态）
  flyout.querySelectorAll<HTMLElement>(".role-row").forEach((row) => {
    row.addEventListener("click", () => {
      flyout.querySelectorAll(".role-row").forEach((r) => {
        r.classList.remove("selected");
      });
      row.classList.add("selected");
    });
  });
}

function showFlyout(): void {
  renderUserFlyout();
  document.getElementById("user-flyout")!.classList.remove("hidden");
}

function hideFlyout(): void {
  document.getElementById("user-flyout")!.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// 扫码登录（对应原版 UserQRCodeDialog）
// ---------------------------------------------------------------------------

let qrTimer: number | undefined;

function stopQrPolling(): void {
  window.clearInterval(qrTimer);
  qrTimer = undefined;
}

async function refreshQr(): Promise<void> {
  setStatus("正在生成二维码…");
  const created = await api.qrCreate();
  const holder = document.getElementById("qr-holder");
  if (holder) {
    holder.innerHTML = created.svg;
  }
  setStatus("请使用米游社 App 扫码");

  stopQrPolling();
  qrTimer = window.setInterval(() => {
    void pollQr(created.ticket);
  }, 3000);
}

async function pollQr(ticket: string): Promise<void> {
  let poll;
  try {
    poll = await api.qrPoll(ticket);
  } catch (e) {
    stopQrPolling();
    toast(errText(e), "error");
    return;
  }

  switch (poll.status) {
    case "Init":
      setStatus("等待扫码…");
      return;
    case "Scanned":
      setStatus("已扫码，请在手机上确认");
      return;
    case "Expired":
      stopQrPolling();
      void refreshQr().catch((e: unknown) => toast(errText(e), "error"));
      return;
    case "Confirmed":
      stopQrPolling();
      closeDialog();
      if (poll.user) {
        currentUserId = poll.user.id;
      }
      toast(`已添加用户 ${poll.user?.nickname ?? ""}`, "success");
      await reload();
      return;
  }
}

function openQrDialog(): void {
  openDialog("扫码登录", '<div id="qr-holder" class="qr-holder"></div>', null);
  onDialogCancel(() => {
    stopQrPolling();
    closeDialog();
  });
  refreshQr().catch((e: unknown) => {
    toast(errText(e), "error");
    closeDialog();
  });
}

// ---------------------------------------------------------------------------
// 手机验证码登录（对应原版 UserMobileCaptchaDialog）
// ---------------------------------------------------------------------------

function openCaptchaDialog(): void {
  openDialog(
    "手机验证码",
    `
    <label>手机号
      <input id="cap-mobile" type="tel" placeholder="11 位手机号" maxlength="11"/>
    </label>
    <div class="captcha-row">
      <label>验证码
        <input id="cap-code" type="text" placeholder="短信验证码" maxlength="6"/>
      </label>
      <button id="cap-send">发送验证码</button>
    </div>
    <p class="hint">验证码登录可能触发极验风控，此时请改用扫码登录</p>`,
    "登录",
  );

  let actionType = "";

  document.getElementById("cap-send")!.addEventListener("click", () => {
    void (async () => {
      const mobile = (document.getElementById("cap-mobile") as HTMLInputElement).value.trim();
      if (!/^\d{11}$/.test(mobile)) {
        toast("请输入 11 位手机号", "error");
        return;
      }
      setStatus("正在发送验证码…");
      try {
        const sent = await api.captchaSend(mobile);
        actionType = sent.action_type;
        setStatus(`验证码已发送（${sent.countdown}s 内有效）`);
      } catch (e) {
        setStatus("");
        toast(errText(e), "error");
      }
    })();
  });

  onDialogOk(() =>
    runWithOkGuard(async () => {
      const mobile = (document.getElementById("cap-mobile") as HTMLInputElement).value.trim();
      const code = (document.getElementById("cap-code") as HTMLInputElement).value.trim();
      if (!actionType) {
        throw new Error("请先发送验证码");
      }
      setStatus("正在登录…");
      const user = await api.captchaLogin(mobile, code, actionType);
      closeDialog();
      currentUserId = user.id;
      toast(`已添加用户 ${user.nickname ?? ""}`, "success");
      await reload();
    }),
  );
  onDialogCancel(closeDialog);
}

// ---------------------------------------------------------------------------
// 手动输入 Cookie（对应原版 UserDialog）
// ---------------------------------------------------------------------------

function openCookieDialog(isOversea: boolean): void {
  openDialog(
    isOversea ? "手动输入 · HoYoLAB" : "手动输入 · 米游社",
    `
    <label>Cookie 字符串
      <textarea id="ck-raw" rows="6" placeholder="粘贴包含 stuid/stoken/mid 的 Cookie，例如：stuid=xxx;stoken=xxx;mid=xxx"></textarea>
    </label>
    <p class="hint">仅支持包含 SToken 的 Cookie，它是后续刷新其它凭证的根凭证</p>`,
    "添加",
  );

  const raw = document.getElementById("ck-raw") as HTMLTextAreaElement;
  raw.addEventListener("input", () => {
    setOkEnabled(raw.value.trim().length > 0);
  });
  setOkEnabled(false);

  onDialogOk(() =>
    runWithOkGuard(async () => {
      setStatus("正在验证并初始化凭证链…");
      const user = await api.cookieLogin(raw.value.trim(), isOversea);
      closeDialog();
      currentUserId = user.id;
      toast(`已添加用户 ${user.nickname ?? ""}`, "success");
      await reload();
    }),
  );
  onDialogCancel(closeDialog);
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function reload(): Promise<void> {
  users = await api.listUsers();
  if (currentUserId === null || !users.some((u) => u.id === currentUserId)) {
    currentUserId = users[0]?.id ?? null;
  }
  renderFooterUser();
  renderPage();
}

// ---------------------------------------------------------------------------
// 入口：窗口控制 + 导航 + 事件
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 尽早恢复主题，避免首帧闪烁暗色
  initTheme();

  // 渲染异常直接显示在页面上，避免静默失败导致"某个控件不见了"却无从排查
  window.addEventListener("error", (ev) => {
    const el = document.getElementById("toast");
    if (el) {
      el.textContent = `页面错误: ${ev.message}`;
      el.className = "toast error";
      window.setTimeout(() => el.classList.add("hidden"), 6000);
    }
  });

  // 标题栏窗口控制
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  initUpdateBadge();
  document.getElementById("win-min")!.addEventListener("click", () => {
    void win.minimize();
  });
  document.getElementById("win-max")!.addEventListener("click", () => {
    void win.toggleMaximize();
  });
  document.getElementById("win-close")!.addEventListener("click", () => {
    void win.close();
  });

  // 导航与用户菜单
  renderNav();
  document.getElementById("user-menu-btn")!.addEventListener("click", () => {
    const el = document.getElementById("user-flyout")!;
    if (el.classList.contains("hidden")) {
      showFlyout();
    } else {
      hideFlyout();
    }
  });
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.closest(".nav-footer")) {
      hideFlyout();
    }
  });

  // 启动 5 秒后静默检查更新（不阻塞首屏）
  window.setTimeout(() => {
    void checkForUpdates(true);
  }, 5000);

  // 后端广播（启动懒刷新等）后统一重载
  const { listen } = await import("@tauri-apps/api/event");
  await listen("users://changed", () => {
    void reload().catch((e: unknown) => toast(errText(e), "error"));
  });

  await reload().catch((e: unknown) => toast(errText(e), "error"));
}

void main();
