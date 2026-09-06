// 应用更新检查（Tauri v2 updater：GitHub Releases 分发，minisign 签名校验）
import type { Update } from "@tauri-apps/plugin-updater";
import { closeDialog, onDialogCancel, onDialogOk, openDialog, setStatus, toast } from "./ui";

/** 待安装的更新：静默检查发现新版本时先挂起，由标题栏徽标触发安装 */
let pendingUpdate: Update | null = null;

/**
 * 检查更新。发现新版本一律弹窗明确告知；
 * 用户取消（或更新失败）后点亮标题栏徽标作为持续提醒。
 */
export async function checkForUpdates(silent: boolean): Promise<void> {
  console.info("[updater] 检查更新…");
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

/** 标题栏更新徽标（位于最小化按钮左侧）：轻微高亮提示有新版本 */
export function showUpdateBadge(version: string): void {
  const btn = document.getElementById("win-update");
  if (!btn) {
    return;
  }
  const label = btn.querySelector("span");
  if (label) {
    label.textContent = `v${version}`;
  }
  btn.title = `发现新版本 v${version}，点击下载更新`;
  btn.classList.remove("hidden");
}

export function initUpdateBadge(): void {
  document.getElementById("win-update")?.addEventListener("click", () => {
    if (pendingUpdate) {
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
    ${update.body ? `<div class="update-notes">${update.body}</div>` : ""}`,
    "立即更新",
  );
  onDialogCancel(() => {
    closeDialog();
    // 用户暂不更新：点亮标题栏徽标作为持续提醒
    showUpdateBadge(update.version);
  });
  onDialogOk(() =>
    void (async () => {
      try {
        setStatus("正在下载更新…");
        let downloaded = 0;
        let total = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started" && event.data.contentLength) {
            total = event.data.contentLength;
          } else if (event.event === "Progress" && event.data.chunkLength) {
            downloaded += event.data.chunkLength;
            if (total > 0) {
              const pct = Math.min(100, Math.round((downloaded / total) * 100));
              setStatus(`正在下载更新… ${pct}%`);
            }
          }
        });
        setStatus("下载完成，正在重启应用…");
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (e) {
        toast(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "error");
        closeDialog();
        showUpdateBadge(update.version);
      }
    })(),
  );
}
