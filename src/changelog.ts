// 新版本首次启动时展示更新说明（对应 BetterGI CheckUpdateWindow 的日志展示）
// localStorage 记录已读版本；当前版本更新时拉取 OSS 更新说明弹窗展示。
import { api } from "./api";
import { isNewerVersion } from "./updater";
import { closeDialog, onDialogOk, openDialog } from "./ui";

const KEY = "hoyo-last-changelog";

/** 极简 markdown → html（标题/粗体/行内代码/列表/段落），仅用于更新说明展示 */
function mdToHtml(md: string): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const out: string[] = [];
  let inList = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{1,3}\s+/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h3>${inline(line.replace(/^#{1,3}\s+/, ""))}</h3>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else if (line === "") {
      if (inList) { out.push("</ul>"); inList = false; }
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) { out.push("</ul>"); }
  return out.join("\n");
}

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
