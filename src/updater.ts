// 应用更新检查（Tauri v2 updater：OSS/CNB 国内源 + GitHub 兜底，minisign 签名校验）
import type { Update } from "@tauri-apps/plugin-updater";
import { api } from "./api";
import { mdToHtml } from "./md";
import { closeDialog, onDialogCancel, onDialogOk, openDialog, toast } from "./ui";

/** 待安装的更新：静默检查发现新版本时先挂起，由标题栏徽标触发安装 */
let pendingUpdate: Update | null = null;

/**
 * 徽标状态机：notify（有新版本）→ downloading（后台下载，徽标显示进度）
 * → ready（下载完成，徽标变「安装更新」按钮）。失败回 notify 可重试。
 */
type BadgePhase = "notify" | "downloading" | "ready";
let badgePhase: BadgePhase = "notify";
let downloadPct = 0;

/**
 * 下载展示位置：dialog（默认前台，弹窗内进度条）或 background（徽标）。
 * 前台下载中点「后台下载」只切换展示位置，下载本身不中断。
 */
type DownloadPhase = "dialog" | "background";
let downloadPhase: DownloadPhase = "dialog";

// ---------------------------------------------------------------------------
// 版本比较与灰度门控（对应 BetterGI UpdateFromOss 的 Gray 逻辑）
// ---------------------------------------------------------------------------

/** a 是否比 b 新（按点分段数值比较，忽略预发布后缀） */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return false;
}

/** 稳定设备 ID（灰度哈希用，localStorage 持久化） */
function deviceId(): string {
  const KEY = "hoyo-device-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** 灰度命中：deviceId 哈希 %10 < gray（gray=10 全量，0 熔断） */
export function grayEligible(gray: number): boolean {
  let hash = 0;
  for (const ch of deviceId()) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return hash % 10 < gray;
}

/** 带超时的 Promise 包装 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("超时")), ms))]);
}

/**
 * 检查更新。国内主源为 OSS notice.json（含灰度）：
 *   - OSS 无新版本 → 已是最新（OSS 优先于 GitHub 判断）
 *   - 自动检查未命中灰度 → 静默跳过；手动检查为逃生门，不受灰度限制
 *   - OSS 不可达 → 回退 tauri updater 的 GitHub 直查（endpoints 第二顺位）
 * 发现新版本一律弹窗明确告知；用户取消（或更新失败）后点亮标题栏徽标作为持续提醒。
 */
export async function checkForUpdates(silent: boolean): Promise<void> {
  console.info("[updater] 检查更新…");
  try {
    const notice = await withTimeout(api.updateNotice(), 6000);
    const { getVersion } = await import("@tauri-apps/api/app");
    const current = await getVersion();
    if (!isNewerVersion(notice.version, current)) {
      console.info("[updater] 已是最新版本");
      if (!silent) {
        toast("当前已是最新版本", "success");
      }
      return;
    }
    if (silent && !grayEligible(notice.gray)) {
      console.info(`[updater] 新版本 v${notice.version} 灰度未命中（gray=${notice.gray}），本轮跳过`);
      return;
    }
  } catch (e) {
    console.warn(`[updater] OSS 通告不可达，回退 GitHub 直查: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      console.info("[updater] 已是最新版本");
      if (!silent) {
        toast("当前已是最新版本", "success");
      }
      return;
    }
    console.info(`[updater] 发现新版本 v${update.version}`);
    pendingUpdate = update;
    await showUpdateDialog(update);
  } catch (e) {
    console.warn(`[updater] 检查更新失败: ${e instanceof Error ? e.message : String(e)}`);
    if (!silent) {
      toast(`检查更新失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
}

/** 设置标题栏更新徽标（位于最小化按钮左侧）的文案/提示/状态样式 */
function setBadge(text: string, title: string, phase: BadgePhase): void {
  const btn = document.getElementById("win-update");
  if (!btn) {
    return;
  }
  const label = btn.querySelector("span");
  if (label) {
    label.textContent = text;
  }
  btn.title = title;
  btn.classList.remove("hidden", "downloading", "ready");
  if (phase !== "notify") {
    btn.classList.add(phase);
  }
}

/** 有新版本待处理：徽标轻微高亮，点击弹确认窗 */
export function showUpdateBadge(version: string): void {
  badgePhase = "notify";
  downloadPct = 0;
  setBadge(`v${version}`, `发现新版本 v${version}，点击下载更新`, "notify");
}

export function initUpdateBadge(): void {
  document.getElementById("win-update")?.addEventListener("click", () => {
    if (badgePhase === "ready" && pendingUpdate) {
      void installPendingUpdate();
    } else if (badgePhase === "downloading") {
      toast(`正在后台下载更新（${downloadPct > 0 ? `${downloadPct}%` : "进行中"}），完成后点击此处安装`);
    } else if (pendingUpdate) {
      void showUpdateDialog(pendingUpdate);
    } else {
      void checkForUpdates(false);
    }
  });
}

async function showUpdateDialog(update: Update): Promise<void> {
  openDialog(
    "发现新版本",
    `
    <p class="confirm-message">新版本 <b>v${update.version}</b> 可用，是否立即更新？</p>
    ${update.body ? `<div class="update-notes">${mdToHtml(update.body)}</div>` : ""}`,
    "立即更新",
  );
  onDialogCancel(() => {
    closeDialog();
    // 用户暂不更新：点亮标题栏徽标作为持续提醒
    showUpdateBadge(update.version);
  });
  onDialogOk(() => {
    // 默认前台下载：弹窗切换为进度条形态，唯一按钮「后台下载」可随时转后台
    downloadPhase = "dialog";
    openDownloadProgressDialog(update);
    void startDownload(update);
  });
}

/** 前台下载弹窗：进度条 + 「后台下载」按钮（网速慢可转徽标后台模式） */
function openDownloadProgressDialog(update: Update): void {
  openDialog(
    "正在下载更新",
    `
    <p class="confirm-message">正在下载 <b>v${update.version}</b>，完成后将自动安装并重启应用。</p>
    <div class="dl-progress">
      <div class="dl-bar"><div class="dl-fill" id="dl-fill"></div></div>
      <div class="dl-meta"><span id="dl-pct">0%</span><span id="dl-size">准备中…</span></div>
    </div>`,
    "后台下载",
    { cancelable: false },
  );
  onDialogOk(() => {
    // 只切换展示位置，下载不中断：进度转由标题栏徽标显示，完成后徽标变「安装更新」
    downloadPhase = "background";
    badgePhase = "downloading";
    setBadge(downloadPct > 0 ? `${downloadPct}%` : "下载中…", `正在后台下载 v${update.version}…`, "downloading");
    closeDialog();
    toast("已转为后台下载，完成后点击右上角「安装更新」");
  });
}

/** 更新前台弹窗进度条（弹窗被关闭后元素不存在，静默跳过） */
function setDialogProgress(pct: number, received: number, total: number, speedBps: number): void {
  const fill = document.getElementById("dl-fill");
  if (!fill) {
    return;
  }
  fill.style.width = `${pct}%`;
  const pctEl = document.getElementById("dl-pct");
  if (pctEl) {
    pctEl.textContent = `${pct}%`;
  }
  const sizeEl = document.getElementById("dl-size");
  if (sizeEl) {
    const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
    const speed = speedBps > 0 ? ` · ${(speedBps / 1024 / 1024).toFixed(2)} MB/s` : "";
    sizeEl.textContent = total > 0 ? `${mb(received)} / ${mb(total)}${speed}` : `${mb(received)}${speed}`;
  }
}

/** MB/s 字节格式化（徽标 tooltip 用） */
function fmtMB(b: number): string {
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 下载更新（只启动一次）。前台（dialog）：弹窗进度条，完成即自动安装重启；
 * 后台（background）：徽标显示进度，完成后徽标变「安装更新」由用户触发。
 * 前台进行中点「后台下载」仅切换 downloadPhase，本函数的回调据此切换 UI。
 */
async function startDownload(update: Update): Promise<void> {
  badgePhase = "downloading";
  downloadPct = 0;
  let received = 0;
  let total = 0;
  let speed = 0;
  let lastTick = performance.now();
  let lastReceived = 0;
  let lastBadgePct = -1;
  try {
    await update.download((event) => {
      if (event.event === "Started" && event.data.contentLength) {
        total = event.data.contentLength;
      } else if (event.event === "Progress" && event.data.chunkLength) {
        received += event.data.chunkLength;
        // 每 600ms 平滑一次速度，避免数字跳动
        const now = performance.now();
        if (now - lastTick > 600) {
          speed = ((received - lastReceived) / (now - lastTick)) * 1000;
          lastTick = now;
          lastReceived = received;
        }
        if (total > 0) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          downloadPct = pct;
          if (downloadPhase === "dialog") {
            setDialogProgress(pct, received, total, speed);
          } else if (pct !== lastBadgePct) {
            lastBadgePct = pct;
            setBadge(`${pct}%`, `正在后台下载 v${update.version}（${pct}%）…`, "downloading");
          }
        }
      }
    });
    console.info(`[updater] v${update.version} 下载完成（${fmtMB(received)}）`);
    if (downloadPhase === "dialog") {
      // 前台完成：直接安装并重启（Windows 下 install 自动退出重启）
      const pctEl = document.getElementById("dl-pct");
      if (pctEl) {
        pctEl.textContent = "下载完成，正在安装…";
      }
      await update.install();
    } else {
      badgePhase = "ready";
      setBadge("安装更新", `v${update.version} 已下载完成，点击安装并重启应用`, "ready");
      toast(`v${update.version} 下载完成，点击右上角「安装更新」完成升级`, "success");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (downloadPhase === "dialog") {
      // 前台失败：回到确认弹窗可重试
      toast(`更新下载失败: ${msg}`, "error");
      showUpdateBadge(update.version);
      void showUpdateDialog(update);
    } else {
      badgePhase = "notify";
      setBadge(`v${update.version}`, "下载失败，点击重试", "notify");
      toast(`更新下载失败: ${msg}`, "error");
    }
  }
}

/** 安装已下载的更新。Windows 下 install() 启动安装器后会自动退出并重启应用 */
async function installPendingUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update) {
    return;
  }
  setBadge("安装中…", "正在安装更新，应用即将重启", "ready");
  try {
    await update.install();
  } catch (e) {
    badgePhase = "notify";
    setBadge(`v${update.version}`, "安装失败，点击重试", "notify");
    toast(`安装更新失败: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
