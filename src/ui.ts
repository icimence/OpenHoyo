/** 极简对话框 + Toast，替代 WinUI 的 ContentDialog 交互 */

export type DialogResult = "ok" | "cancel";

const layer = (): HTMLElement => document.getElementById("dialog-layer")!;
const box = (): HTMLElement => document.getElementById("dialog")!;

export function openDialog(
  title: string,
  bodyHtml: string,
  okText: string | null,
  options?: { cancelable?: boolean },
): void {
  const cancelable = options?.cancelable ?? true;
  box().innerHTML = `
    <div class="dialog-title">${title}</div>
    <div class="dialog-body">${bodyHtml}</div>
    ${cancelable || okText ? `<div class="dialog-footer">
      <span class="dialog-status" id="dialog-status"></span>
      <div class="dialog-buttons">
        ${okText ? '<button id="dialog-ok" class="primary"></button>' : ""}
        ${cancelable ? '<button id="dialog-cancel"></button>' : ""}
      </div>
    </div>` : ""}`;
  if (okText) {
    (document.getElementById("dialog-ok") as HTMLButtonElement).textContent = okText;
  }
  if (cancelable) {
    (document.getElementById("dialog-cancel") as HTMLButtonElement).textContent = "取消";
  }
  layer().classList.remove("hidden");
}

export function closeDialog(): void {
  layer().classList.add("hidden");
  box().innerHTML = "";
}

export function setStatus(text: string): void {
  const el = document.getElementById("dialog-status");
  if (el) {
    el.textContent = text;
  }
}

export function onDialogOk(handler: () => Promise<void> | void): void {
  const btn = document.getElementById("dialog-ok") as HTMLButtonElement | null;
  if (!btn) {
    return;
  }
  btn.addEventListener("click", () => {
    void handler();
  });
}

export function onDialogCancel(handler: () => void): void {
  document.getElementById("dialog-cancel")?.addEventListener("click", handler);
}

export function setOkEnabled(enabled: boolean): void {
  const btn = document.getElementById("dialog-ok") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = !enabled;
  }
}

let toastTimer: number | undefined;

export function toast(text: string, kind: "info" | "error" | "success" = "info"): void {
  const el = document.getElementById("toast")!;
  el.textContent = text;
  el.className = `toast ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.add("hidden");
  }, 3600);
}

/** “确定前”包装：执行 async 任务时禁用确定按钮，失败弹 toast 并保持对话框 */
export async function runWithOkGuard(task: () => Promise<void>): Promise<void> {
  setOkEnabled(false);
  try {
    await task();
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e), "error");
    setOkEnabled(true);
  }
}

/** 危险操作确认对话框（删除存档等） */
export function confirmDialog(title: string, message: string, confirmText = "删除"): Promise<boolean> {
  return new Promise((resolve) => {
    openDialog(
      title,
      `<p class="confirm-message">${message}</p>`,
      confirmText,
    );
    (document.getElementById("dialog-ok") as HTMLButtonElement).classList.add("danger");
    onDialogOk(() => {
      closeDialog();
      resolve(true);
    });
    onDialogCancel(() => {
      closeDialog();
      resolve(false);
    });
  });
}
