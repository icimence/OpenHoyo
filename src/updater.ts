// 应用更新检查（Tauri v2 updater：GitHub Releases 分发，minisign 签名校验）
import type { Update } from "@tauri-apps/plugin-updater";
import { closeDialog, onDialogCancel, onDialogOk, openDialog, setStatus, toast } from "./ui";

/** 检查更新。silent=true 时无更新不打扰；发现新版本弹出升级对话框 */
export async function checkForUpdates(silent: boolean): Promise<void> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (!silent) {
        toast("当前已是最新版本", "success");
      }
      return;
    }
    await showUpdateDialog(update);
  } catch (e) {
    if (!silent) {
      toast(`检查更新失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
}

async function showUpdateDialog(update: Update): Promise<void> {
  openDialog(
    "发现新版本",
    `
    <p class="confirm-message">新版本 <b>v${update.version}</b> 可用，是否立即更新？</p>
    ${update.body ? `<div class="update-notes">${update.body}</div>` : ""}`,
    "立即更新",
  );
  onDialogCancel(closeDialog);
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
      }
    })(),
  );
}
