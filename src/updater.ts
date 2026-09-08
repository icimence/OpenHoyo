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
    // 确认后立即回到应用，下载在后台进行——进度显示在标题栏徽标，完成后徽标变「安装更新」
    closeDialog();
    void startBackgroundDownload(update);
  });
}

/** 后台下载更新：进度实时反映在标题栏徽标（下载期间不阻塞任何操作） */
async function startBackgroundDownload(update: Update): Promise<void> {
  badgePhase = "downloading";
  downloadPct = 0;
  setBadge("下载中…", `正在后台下载 v${update.version}…`, "downloading");
  try {
    let received = 0;
    let total = 0;
    await update.download((event) => {
      if (event.event === "Started" && event.data.contentLength) {
        total = event.data.contentLength;
      } else if (event.event === "Progress" && event.data.chunkLength) {
        received += event.data.chunkLength;
        if (total > 0) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          if (pct !== downloadPct) {
            downloadPct = pct;
            setBadge(`${pct}%`, `正在后台下载 v${update.version}（${pct}%）…`, "downloading");
          }
        }
      }
    });
    badgePhase = "ready";
    setBadge("安装更新", `v${update.version} 已下载完成，点击安装并重启应用`, "ready");
    console.info(`[updater] v${update.version} 下载完成，等待用户安装`);
    toast(`v${update.version} 下载完成，点击右上角「安装更新」完成升级`, "success");
  } catch (e) {
    badgePhase = "notify";
    setBadge(`v${update.version}`, `下载失败，点击重试`, "notify");
    toast(`更新下载失败: ${e instanceof Error ? e.message : String(e)}`, "error");
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
