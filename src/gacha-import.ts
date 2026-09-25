import { listen } from "@tauri-apps/api/event";
import { api, errText, isApiError } from "./api";
import { closeDialog, openDialog, toast } from "./ui";

interface UigfProgress {
  uid: string;
  processed: number;
  total: number;
}

let importing = false;

/** 文件选择结束后持续占用页面；条数来自后端每批写入的进度事件。 */
export async function importUigf(onComplete: () => Promise<void>): Promise<void> {
  if (importing) return;
  importing = true;
  let unlisten: (() => void) | null = null;
  const shell = document.querySelector<HTMLElement>(".shell");
  const wasInert = shell?.inert ?? false;
  try {
    unlisten = await listen<UigfProgress>("uigf://progress", ({ payload }) => {
      const percent = payload.total > 0 ? Math.min(100, Math.round(payload.processed / payload.total * 100)) : 0;
      const bar = document.getElementById("uigf-progress-bar");
      const status = document.getElementById("uigf-progress-status");
      const meta = document.getElementById("uigf-progress-meta");
      if (bar) {
        bar.style.width = `${percent}%`;
        bar.parentElement?.setAttribute("aria-valuenow", String(percent));
      }
      if (status) status.textContent = `正在导入 UID ${payload.uid}`;
      if (meta) meta.textContent = `${payload.processed.toLocaleString()} / ${payload.total.toLocaleString()} 条 · ${percent}%`;
    });
    openDialog(
      "导入 UIGF 记录",
      `<div class="uigf-import-progress" role="status" aria-live="polite">
      <div id="uigf-progress-status">请选择要导入的 UIGF 文件…</div>
      <div class="uigf-progress-track" role="progressbar" aria-label="导入进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div id="uigf-progress-bar" class="uigf-progress-fill"></div>
      </div>
      <div id="uigf-progress-meta">读取文件后显示进度</div>
      <p>导入期间请稍候，完成后会自动刷新祈愿记录。</p>
    </div>`,
      null,
      { cancelable: false },
    );
    if (shell) shell.inert = true;
    console.info("[gacha] 开始导入 UIGF");
    const report = await api.uigfImport();
    const status = document.getElementById("uigf-progress-status");
    if (status) status.textContent = "导入完成，正在刷新统计…";
    await onComplete();
    const inserted = report.accounts.reduce((total, account) => total + account.inserted, 0);
    const skipped = report.accounts.reduce((total, account) => total + account.skipped, 0);
    console.info(`[gacha] UIGF 导入完成：新增 ${inserted} 条，跳过 ${skipped} 条`);
    toast(`导入完成：新增 ${inserted} 条，跳过 ${skipped} 条`, "success");
  } catch (error) {
    if (!(isApiError(error) && error.code === -100)) {
      console.warn(`[gacha] UIGF 导入失败: ${errText(error)}`);
      toast(`UIGF 导入失败: ${errText(error)}`, "error");
    }
  } finally {
    closeDialog();
    if (shell) shell.inert = wasInert;
    unlisten?.();
    importing = false;
  }
}
