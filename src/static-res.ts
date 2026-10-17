// 图像资源与数据文件夹的共用前端逻辑（首次启动引导与设置页共用）。
import { api, errText, type GroupProgress } from "./api";
import { confirmDialog, toast } from "./ui";

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (n >= 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

function escHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** 选择并校验数据文件夹（目录不可用时提示原因；已有本应用数据时确认覆盖）。返回可用路径或 null */
export async function pickDataFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "选择数据文件夹" });
  if (typeof picked !== "string" || !picked) {
    return null;
  }
  try {
    const check = await api.dataFolderCheck(picked);
    if (check.has_existing_data) {
      const ok = await confirmDialog("更改数据目录", `选择的文件夹「${escHtml(picked)}」中已有本应用的数据，迁移时将覆盖这些文件。`, "覆盖");
      if (!ok) {
        return null;
      }
    }
    return picked;
  } catch (e) {
    console.warn(`[datafolder] 所选目录不可用: ${errText(e)}`);
    toast(errText(e), "error");
    return null;
  }
}

/** 复制数据到新目录并重启应用（调用前应已让用户明确确认）。失败时提示并返回 false */
export async function migrateDataFolder(path: string): Promise<boolean> {
  try {
    console.info("[datafolder] 开始迁移数据目录");
    await api.dataFolderSet(path);
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return true;
  } catch (e) {
    console.warn(`[datafolder] 迁移失败: ${errText(e)}`);
    toast(`迁移失败：${errText(e)}`, "error");
    return false;
  }
}

/**
 * 设置页的更改数据文件夹（对应原版 SettingStorageSetDataFolderOperation）：
 * 选目录 → 校验 → 二次确认 → 复制数据 → 重启生效。返回是否已发起重启。
 */
export async function changeDataFolder(): Promise<boolean> {
  const picked = await pickDataFolder();
  if (!picked) {
    return false;
  }
  const go = await confirmDialog(
    "更改数据目录",
    `将把账号、祈愿记录、挑战记录和已下载的图像资源复制到：<br/><b>${escHtml(picked)}</b><br/><br/>完成后应用会自动重启，旧位置的数据在新位置确认可用后自动删除。`,
    "复制并重启",
  );
  return go ? migrateDataFolder(picked) : false;
}

/** 下载资源组并持续回调进度（static://progress 事件） */
export async function downloadGroups(groups: string[], onProgress: (p: GroupProgress) => void): Promise<GroupProgress[]> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<GroupProgress>("static://progress", (ev) => onProgress(ev.payload));
  try {
    console.info(`[static] 开始下载图像资源: ${groups.join(",")}`);
    const results = await api.staticDownload(groups);
    console.info(`[static] 下载结束: ${results.map((r) => `${r.key}=${r.state}(${r.done}/${r.total})`).join(" ")}`);
    return results;
  } finally {
    unlisten();
  }
}

/** 进度卡 HTML（对应原版 DownloadSummaryTemplate） */
export function progressCard(name: string, p: GroupProgress | undefined): string {
  // 没有需要下载的文件（total=0）而已完成时显示 100%，避免出现「0% · 完成」
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : p?.state === "done" ? 100 : 0;
  const text = !p
    ? "等待中"
    : p.state === "running"
      ? `${p.done}/${p.total}${p.bytes > 0 ? ` · ${fmtBytes(p.bytes)}` : ""}${p.message ? ` · ${p.message}` : ""}`
      : p.message || `${p.done}/${p.total}`;
  return `
    <div class="sr-progress ${p?.state ?? "pending"}">
      <div class="sr-progress-head"><span>${name}</span><span class="sr-progress-pct">${p ? `${pct}%` : ""}</span></div>
      <div class="sr-bar"><div class="sr-bar-fill" style="width:${p?.state === "done" ? 100 : pct}%"></div></div>
      <div class="sr-progress-text">${text}</div>
    </div>`;
}
