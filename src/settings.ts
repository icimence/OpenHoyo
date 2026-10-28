// 设置页：主题切换（跟随系统/浅色/深色）、当前版本号与手动检查更新、数据文件夹与图像资源、反馈中心
import { checkForUpdates } from "./updater";
import { api, errText, type GroupProgress, type StaticStatus, type UserDto } from "./api";
import { renderReminderSettings } from "./reminders";
import { changeDataFolder, downloadGroups, fmtBytes, progressCard } from "./static-res";
import { confirmDialog, toast } from "./ui";
import { isMobile } from "./platform";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export type ThemeMode = "auto" | "light" | "dark";

const THEME_KEY = "hoyo-theme";

export function loadThemeMode(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v === "auto" || v === "light" || v === "dark" ? v : "dark";
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode;
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(mode);
}

/** 启动时恢复主题，并在跟随系统模式下实时响应系统切换 */
export function initTheme(): void {
  applyTheme(loadThemeMode());
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (loadThemeMode() === "auto") {
      applyTheme("auto");
    }
  });
}

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: "auto", label: "跟随系统" },
  { mode: "light", label: "浅色" },
  { mode: "dark", label: "深色" },
];

const SETTINGS_TABS = [
  { key: "general", label: "常规" },
  { key: "reminders", label: "提醒" },
  { key: "storage", label: "存储与图像资源" },
  { key: "feedback", label: "反馈中心" },
];

const TAB_KEY = "hoyo-settings-tab";

function bindTabs(content: HTMLElement): void {
  const show = (key: string): void => {
    content.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((t) => {
      const on = t.dataset.tab === key;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    });
    content.querySelectorAll<HTMLElement>(".settings-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== key));
  };
  content.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((t) => {
    t.addEventListener("click", () => {
      localStorage.setItem(TAB_KEY, t.dataset.tab!);
      show(t.dataset.tab!);
    });
  });
  const saved = localStorage.getItem(TAB_KEY);
  show(SETTINGS_TABS.some((t) => t.key === saved) ? saved! : SETTINGS_TABS[0].key);
}

function fmtWhen(ms: number): string {
  if (!ms) {
    return "从未下载";
  }
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function renderSettingsPage(content: HTMLElement, user?: UserDto): Promise<void> {
  // 版本号取自构建时嵌入的 tauri.conf.json，正是更新成功与否的判据
  let version = "";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    version = await getVersion();
  } catch {
    version = "";
  }

  // 版式参考 Langfuse 设置页：页头 + 下划线 Tab，每个分区是「标题 + 说明」+ 卡片
  content.innerHTML = `
    <div class="page-header"><h2>设置</h2><p>外观、更新、数据存储与反馈</p></div>
    <nav class="settings-tabs" role="tablist">
      ${SETTINGS_TABS.map((t) => `<button role="tab" class="settings-tab" data-tab="${t.key}">${t.label}</button>`).join("")}
    </nav>

    <section class="settings-panel" data-panel="general">
      <div class="settings-section">
        <div class="settings-section-head"><h3>外观</h3><p>选择应用的配色方案</p></div>
        <div class="setting-card">
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-label">主题</div>
              <div class="setting-desc">跟随系统时自动匹配${isMobile() ? "手机" : " Windows "}的深浅色设置</div>
            </div>
            <div class="segmented" id="theme-seg">
              ${THEME_OPTIONS.map((o) => `<button data-mode="${o.mode}">${o.label}</button>`).join("")}
            </div>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-head"><h3>版本与更新</h3><p>${
          isMobile()
            ? "发现新版本时会提示下载安装包，覆盖安装后原有数据保留"
            : "更新经 GitHub Releases 分发，安装包带有 minisign 签名校验"
        }</p></div>
        <div class="setting-card">
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-label">当前版本</div>
              <div class="setting-desc">更新完成后此处的版本号会随之变化</div>
            </div>
            <div class="setting-version">v${version || "未知"}</div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-label">检查更新</div>
              <div class="setting-desc">有新版本时会提示下载与安装</div>
            </div>
            <button class="primary nowrap" id="btn-check-update"><svg><use href="#i-refresh"/></svg>检查更新</button>
          </div>
        </div>
      </div>
    </section>

    <section class="settings-panel" data-panel="reminders"><div id="reminder-settings" class="reminder-settings"></div></section>
    <section class="settings-panel" data-panel="storage">
      <div class="settings-section">
        <div class="settings-section-head"><h3>数据文件夹</h3><p>${
          isMobile()
            ? "保存账号凭证、祈愿记录、挑战记录与本地图片；位于应用私有存储，卸载应用时一并删除"
            : "保存账号凭证、祈愿记录、挑战记录与本地图片；更改后会复制数据并重启应用"
        }</p></div>
        <div class="setting-card">
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-label" id="sr-dir-kind">当前位置</div>
              <code class="setting-path" id="sr-dir">读取中…</code>
            </div>
            ${isMobile() ? "" : `<div class="setting-actions">
              <button class="nowrap" id="sr-open">打开</button>
              <button class="nowrap" id="sr-move">更改…</button>
            </div>`}
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-head"><h3>图像资源</h3><p>所有图片都来自米哈游官方服务器</p></div>
        <div class="setting-card">
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-label">保存到本地</div>
              <div class="setting-desc">开启后，看到的图片会保存在数据文件夹中，离线也能显示、加载更快</div>
            </div>
            <div class="segmented" id="sr-enabled">
              <button data-on="1">开启</button>
              <button data-on="0">关闭</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-label">本地占用</div>
              <div class="setting-desc" id="sr-usage">—</div>
            </div>
            <button class="nowrap" id="sr-clear">清空本地图片</button>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-head"><h3>资源组</h3><p>只下载本地缺失的文件；开启「保存到本地」后，应用启动时也会自动检查</p></div>
        <div class="sr-table" id="sr-groups"></div>
      </div>
    </section>

    <section class="settings-panel" data-panel="feedback">
      <div class="settings-section">
        <div class="settings-section-head"><h3>反馈中心</h3><p>${
          isMobile()
            ? "提交时会附带应用信息与最近 10 分钟运行日志；完整反馈正文复制到剪贴板，并在浏览器打开 GitHub Issue 页面，粘贴到正文框即可提交"
            : "提交时会自动附带应用元数据、最近 10 分钟运行日志与崩溃转储（如有），打包为 zip；反馈正文复制到剪贴板并打开 GitHub Issue 页面，粘贴后拖入附件即可提交"
        }</p></div>
        <div class="setting-card" id="fb-card">
          <div class="fb-form">
            <textarea id="fb-text" class="fb-textarea" placeholder="请描述遇到的问题：做了什么操作、期望的结果、实际的结果…（至少 5 个字）"></textarea>
            ${
              // 安卓：选图返回 content:// URI、也没有崩溃转储，截图请直接在 Issue 页面上传
              isMobile()
                ? ""
                : `<div class="fb-toolbar">
              <button id="fb-add-image"><svg><use href="#i-copy"/></svg>添加图片</button>
              <div class="fb-chips" id="fb-chips"></div>
            </div>`
            }
            <label class="fb-check"><input type="checkbox" id="fb-logs" checked />附带最近 10 分钟运行日志</label>
            ${isMobile() ? "" : `<label class="fb-check"><input type="checkbox" id="fb-dumps" checked />附带崩溃转储 .dmp（未发现时自动跳过）</label>`}
            <div class="fb-actions">
              <button class="primary" id="fb-submit"><svg><use href="#i-launch"/></svg>提交反馈到 GitHub</button>
              <span class="fb-hint" id="fb-hint"></span>
            </div>
          </div>
        </div>
      </div>
    </section>`;

  bindTabs(content);
  void renderReminderSettings(content.querySelector<HTMLElement>("#reminder-settings")!, user);

  const seg = content.querySelector<HTMLElement>("#theme-seg")!;
  const markActive = (): void => {
    seg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === loadThemeMode());
    });
  };
  seg.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode as ThemeMode;
      localStorage.setItem(THEME_KEY, mode);
      applyTheme(mode);
      markActive();
    });
  });
  markActive();

  bindStaticResources(content);

  const checkBtn = content.querySelector<HTMLButtonElement>("#btn-check-update")!;
  checkBtn.addEventListener("click", () => {
    checkBtn.disabled = true;
    void checkForUpdates(false).finally(() => {
      checkBtn.disabled = false;
    });
  });

  // ---- 反馈中心 ----
  const fbImages: string[] = [];
  const chipsEl = content.querySelector<HTMLElement>("#fb-chips");
  const renderChips = (): void => {
    if (!chipsEl) {
      return;
    }
    chipsEl.innerHTML = fbImages
      .map((p, i) => {
        const name = p.split(/[\\/]/).pop() ?? p;
        return `<span class="fb-chip" title="${esc(p)}">${esc(name)}<button data-i="${i}" title="移除">×</button></span>`;
      })
      .join("");
  };
  chipsEl?.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]");
    if (btn) {
      fbImages.splice(Number(btn.dataset.i), 1);
      renderChips();
    }
  });

  content.querySelector<HTMLButtonElement>("#fb-add-image")?.addEventListener("click", () => {
    void (async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: true,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      });
      if (typeof picked === "string") {
        fbImages.push(picked);
      } else if (Array.isArray(picked)) {
        fbImages.push(...picked);
      }
      renderChips();
    })().catch((e: unknown) => toast(errText(e), "error"));
  });

  const fbSubmitBtn = content.querySelector<HTMLButtonElement>("#fb-submit")!;
  const fbHint = content.querySelector<HTMLElement>("#fb-hint")!;
  fbSubmitBtn.addEventListener("click", () => {
    const text = (content.querySelector<HTMLTextAreaElement>("#fb-text")!.value ?? "").trim();
    const includeLogs = (content.querySelector<HTMLInputElement>("#fb-logs")!).checked;
    const includeDumps = content.querySelector<HTMLInputElement>("#fb-dumps")?.checked ?? false;

    void (async () => {
      // 提交前操作指引：让用户知道浏览器打开后要做什么
      const go = await confirmDialog(
        "反馈提交指引",
        isMobile()
          ? `点击「继续提交」后：<br/><br/>` +
              `1. 浏览器将打开 GitHub Issue 页面，<b>标题与问题描述已自动填好</b><br/>` +
              `2. 含运行日志的完整正文已复制到剪贴板，可长按正文框粘贴替换；截图可在页面中直接上传<br/>` +
              `3. 点击 <b>Submit new issue</b> 完成提交`
          : `点击「继续提交」后：<br/><br/>` +
          `1. 浏览器将打开 GitHub Issue 页面，<b>标题与正文（问题描述 + 系统信息）已自动填好</b>，无需修改<br/>` +
          `2. 把资源管理器中已定位的 <b>反馈 zip 包</b>拖入 Issue 正文区上传${fbImages.length > 0 ? "（所选图片也一并拖入）" : ""}<br/>` +
          `3. 点击 <b>Submit new issue</b> 完成提交<br/><br/>` +
          `完整运行日志在 zip 内；剪贴板已准备含日志的完整正文，如需内联展示可在正文框 Ctrl+V 覆盖。`,
        "继续提交",
      );
      if (!go) {
        return;
      }
      fbSubmitBtn.disabled = true;
      fbHint.textContent = "正在打包诊断信息…";
      try {
        const r = await api.feedbackSubmit(text, fbImages.slice(), includeLogs, includeDumps);
        const parts = [`zip：${r.zipPath.split(/[\\/]/).pop() ?? ""}`];
        if (r.dumpCount > 0) {
          parts.push(`崩溃转储 ${r.dumpCount} 个`);
        }
        if (r.imageCount > 0) {
          parts.push(`图片 ${r.imageCount} 张`);
        }
        fbHint.textContent = isMobile()
          ? `Issue 页面已打开（标题正文已预填）${r.clipboardOk ? "；含日志全文已复制，可粘贴到正文框" : ""}，点 Submit new issue 提交`
          : `Issue 页面已打开（标题正文已预填）：请把 ${parts.join("、")}拖入上传，点 Submit new issue 提交${
              r.clipboardOk ? "；含日志全文已复制，可 Ctrl+V 内联" : ""
            }`;
        toast("反馈包已生成，Issue 页面已打开", "success");
      } catch (e: unknown) {
        fbHint.textContent = "";
        toast(errText(e), "error");
      } finally {
        fbSubmitBtn.disabled = false;
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// 数据文件夹与图像资源（对应原版设置页「存储」与首启引导的图像资源设置）
// ---------------------------------------------------------------------------

function bindStaticResources(content: HTMLElement): void {
  const $ = <T extends HTMLElement>(sel: string): T => content.querySelector<T>(sel)!;
  const progress = new Map<string, GroupProgress>();
  let status: StaticStatus | null = null;
  let busy = false;

  const render = (): void => {
    if (!status || !document.body.contains(content)) {
      return;
    }
    $("#sr-dir-kind").textContent = status.is_default_dir ? "当前位置（默认）" : "当前位置（自定义）";
    $("#sr-dir").textContent = status.data_dir;
    $("#sr-enabled")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => b.classList.toggle("active", (b.dataset.on === "1") === status!.enabled));
    $("#sr-usage").textContent = `${status.cache_files} 个文件 · ${fmtBytes(status.cache_bytes)}`;
    $<HTMLButtonElement>("#sr-clear").disabled = busy || status.cache_files === 0;
    content.querySelector<HTMLButtonElement>("#sr-move")?.toggleAttribute("disabled", busy);
    // 资源组表格（对应 Langfuse 设置页的 Table：名称+说明 / 上次下载 / 操作 三列）
    const rows = status.groups
      .map((g) => {
        const p = progress.get(g.key);
        const running = p?.state === "running";
        return `
        <div class="sr-row">
          <div class="sr-cell-main">
            <div class="setting-label">${esc(g.name)}</div>
            <div class="setting-desc">${esc(g.description)}</div>
            ${p ? progressCard("", p) : ""}
          </div>
          <div class="sr-cell-when ${g.fulfilled_at ? "" : "muted"}">${fmtWhen(g.fulfilled_at)}</div>
          <div class="sr-cell-action">
            <button class="nowrap" data-dl="${g.key}" ${busy || !status!.enabled ? "disabled" : ""} title="${status!.enabled ? "" : "请先开启「保存到本地」"}">${running ? "下载中…" : g.fulfilled_at ? "检查更新" : "下载"}</button>
          </div>
        </div>`;
      })
      .join("");
    $("#sr-groups").innerHTML = `
      <div class="sr-row sr-head"><div>资源组</div><div>上次下载</div><div></div></div>
      ${rows}`;
    content.querySelectorAll<HTMLButtonElement>("[data-dl]").forEach((btn) => {
      btn.addEventListener("click", () => void download([btn.dataset.dl!]));
    });
  };

  const refresh = async (): Promise<void> => {
    try {
      status = await api.staticStatus();
      busy = status.downloading;
      render();
    } catch (e) {
      $("#sr-dir").textContent = `读取失败：${errText(e)}`;
    }
  };

  const download = async (groups: string[]): Promise<void> => {
    busy = true;
    render();
    try {
      const results = await downloadGroups(groups, (p) => {
        progress.set(p.key, p);
        render();
      });
      results.forEach((r) => progress.set(r.key, r));
      // 有新增或失败时由标题栏「后台任务」统一 toast；这里只补"无需更新"的反馈，让手动点击有回应
      if (results.every((r) => r.bytes === 0 && r.failed === 0 && r.state === "done")) {
        toast("图像资源已是最新", "success");
      }
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      busy = false;
      await refresh();
    }
  };

  content.querySelector("#sr-open")?.addEventListener("click", () => void api.dataFolderOpen().catch((e: unknown) => toast(errText(e), "error")));
  content.querySelector("#sr-move")?.addEventListener("click", () => void changeDataFolder());
  $("#sr-enabled")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b) => {
      b.addEventListener("click", () => {
        void api
          .staticSetEnabled(b.dataset.on === "1")
          .then(refresh)
          .catch((e: unknown) => toast(errText(e), "error"));
      });
    });
  $("#sr-clear").addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog("清空本地图片", "将删除数据文件夹中保存的全部图像资源，之后图片会重新从米哈游官方服务器加载。账号与记录数据不受影响。", "清空");
      if (!ok) {
        return;
      }
      try {
        await api.staticClear();
        progress.clear();
        toast("已清空本地图片", "success");
      } catch (e) {
        toast(errText(e), "error");
      }
      await refresh();
    })();
  });

  void refresh();
}
