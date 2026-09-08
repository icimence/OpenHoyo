// 新版本首次启动时展示更新说明（对应 BetterGI CheckUpdateWindow 的日志展示）
// localStorage 记录已读版本；当前版本更新时拉取 OSS 更新说明弹窗展示。
import { api } from "./api";
import { mdToHtml } from "./md";
import { isNewerVersion } from "./updater";
import { closeDialog, onDialogOk, openDialog } from "./ui";

const KEY = "hoyo-last-changelog";

/** 启动时调用：当前版本未展示过更新说明则弹窗（失败静默） */
export async function initChangelog(): Promise<void> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const current = await getVersion();
    const stored = localStorage.getItem(KEY);
    if (!stored) {
      // 首次安装（或清过存储）：不弹，仅记录基线
      localStorage.setItem(KEY, current);
      return;
    }
    if (!isNewerVersion(current, stored)) {
      return;
    }
    localStorage.setItem(KEY, current);

    let md = "";
    try {
      md = await api.updateNotes(current);
    } catch {
      console.warn("[changelog] 更新说明拉取失败，跳过展示");
      return;
    }
    console.info(`[changelog] 展示 v${current} 更新说明`);
    openDialog(
      `更新到 v${current}`,
      `<div class="changelog-body">${mdToHtml(md)}</div>`,
      "知道了",
      { cancelable: false },
    );
    onDialogOk(() => closeDialog());
  } catch (e) {
    console.warn(`[changelog] 初始化失败（不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
  }
}
