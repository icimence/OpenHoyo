// 标题栏「后台任务」（对应原版 MainView 的 BackgroundActivity 按钮）：
// 只在确实有文件要下载时出现（悬停可看各资源组进度），结束即隐藏，并用 toast 告知结果；
// 本地已是最新的检查全程静默。只有用户选择"保存到本地"时后端才会下载，在线模式下始终不出现。
import { api, type GroupProgress } from "./api";
import { fmtBytes } from "./static-res";
import { toast } from "./ui";

interface Item {
  name: string;
  progress: GroupProgress;
}

const items = new Map<string, Item>();
let names = new Map<string, string>();
let running = false;
/** 本轮是否出现过真正需要下载的文件（一旦出现，整轮结束前保持可见） */
let sawWork = false;

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function line(it: Item): string {
  const p = it.progress;
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const status =
    p.state === "running"
      ? p.total > 0
        ? `${p.done}/${p.total}${p.bytes > 0 ? ` · ${fmtBytes(p.bytes)}` : ""}`
        : p.message || "正在准备…"
      : p.state === "done"
        ? p.bytes > 0
          ? `已完成 · 新增 ${fmtBytes(p.bytes)}`
          : "已是最新"
        : p.message;
  return `
    <div class="bg-task ${p.state}">
      <div class="bg-task-head"><span>${esc(it.name)}</span><span class="bg-task-pct">${p.state === "running" && p.total > 0 ? `${pct}%` : ""}</span></div>
      <div class="sr-bar"><div class="sr-bar-fill" style="width:${p.state === "done" ? 100 : pct}%"></div></div>
      <div class="bg-task-status">${esc(status)}</div>
    </div>`;
}

function render(): void {
  const root = document.getElementById("bg-tasks");
  const panel = document.getElementById("bg-tasks-panel");
  const label = document.getElementById("bg-tasks-label");
  if (!root || !panel || !label) {
    return;
  }
  const list = [...items.values()];
  // 只有确实存在待下载文件时才露出（本地已齐全的例行检查不打扰用户）
  sawWork ||= list.some((i) => i.progress.state === "running" && i.progress.total > i.progress.done);
  if (!running || !sawWork) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");
  root.classList.add("running");
  label.textContent = "后台任务";
  panel.innerHTML = `
    <div class="bg-tasks-title">正在下载米哈游官方图像资源</div>
    <div class="bg-tasks-desc">新版本的角色、武器图片会自动保存到本地，不影响正常使用。</div>
    ${list.map(line).join("")}`;
}

/** 一轮下载结束：隐藏标题栏入口，有新增或失败时 toast 告知（无变化则静默） */
function finish(): void {
  const list = [...items.values()];
  items.clear();
  sawWork = false;
  render();
  const bytes = list.reduce((s, i) => s + i.progress.bytes, 0);
  const failed = list.reduce((s, i) => s + i.progress.failed, 0);
  if (failed > 0) {
    toast(`图像资源同步完成，${failed} 个文件未下载成功，显示时会自动重试`, "info");
  } else if (bytes > 0) {
    toast(`图像资源已更新（新增 ${fmtBytes(bytes)}）`, "success");
  }
}

function upsert(p: GroupProgress, name?: string): void {
  items.set(p.key, { name: name ?? names.get(p.key) ?? items.get(p.key)?.name ?? "图像资源", progress: p });
}

export async function initBackgroundTasks(): Promise<void> {
  try {
    const status = await api.staticStatus();
    names = new Map(status.groups.map((g) => [g.key, g.name]));
    // 前端重载时恢复正在进行的任务
    const snap = await api.staticActivity();
    if (snap.downloading) {
      running = true;
      snap.items.forEach((i) => upsert(i, i.name));
      render();
    }
  } catch (e) {
    console.warn(`[bg-tasks] 初始化失败: ${String(e)}`);
  }
  const { listen } = await import("@tauri-apps/api/event");
  await listen<GroupProgress>("static://progress", (ev) => {
    if (!running) {
      // 新一轮下载开始：清掉上一轮的结果
      running = true;
      sawWork = false;
      items.clear();
    }
    upsert(ev.payload);
    render();
  });
  await listen("static://idle", () => {
    running = false;
    finish();
  });
}
