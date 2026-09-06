// 设置页：主题切换（跟随系统/浅色/深色）、当前版本号与手动检查更新、反馈中心
import { checkForUpdates } from "./updater";
import { api, errText, type FeedbackResult } from "./api";
import { toast } from "./ui";

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

export async function renderSettingsPage(content: HTMLElement): Promise<void> {
  // 版本号取自构建时嵌入的 tauri.conf.json，正是更新成功与否的判据
  let version = "";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    version = await getVersion();
  } catch {
    version = "";
  }

  content.innerHTML = `
    <div class="page-header"><h2>设置</h2><p>应用外观与更新</p></div>
    <div class="settings-list">
      <div class="setting-card">
        <div class="setting-row">
          <div class="setting-text">
            <div class="setting-label">主题</div>
            <div class="setting-desc">选择应用外观，跟随系统时自动匹配 Windows 深浅色设置</div>
          </div>
          <div class="segmented" id="theme-seg">
            ${THEME_OPTIONS.map((o) => `<button data-mode="${o.mode}">${o.label}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="setting-card">
        <div class="setting-row">
          <div class="setting-text">
            <div class="setting-label">版本</div>
            <div class="setting-desc">当前安装的版本，更新完成后此处的版本号会随之变化</div>
          </div>
          <div class="setting-version">v${version || "未知"}</div>
        </div>
        <div class="setting-row">
          <div class="setting-text">
            <div class="setting-label">检查更新</div>
            <div class="setting-desc">更新经 GitHub Releases 分发，安装包带有 minisign 签名校验</div>
          </div>
          <button class="primary" id="btn-check-update"><svg><use href="#i-refresh"/></svg>检查更新</button>
        </div>
      </div>
      <div class="setting-card" id="fb-card">
        <div class="setting-row">
          <div class="setting-text">
            <div class="setting-label">反馈中心</div>
            <div class="setting-desc">提交时会自动附带应用元数据、最近 10 分钟运行日志与崩溃转储（如有），打包为 zip；反馈正文复制到剪贴板并打开 GitHub Issue 页面，粘贴后拖入附件即可提交</div>
          </div>
        </div>
        <div class="fb-form">
          <textarea id="fb-text" class="fb-textarea" placeholder="请描述遇到的问题：做了什么操作、期望的结果、实际的结果…（至少 5 个字）"></textarea>
          <div class="fb-toolbar">
            <button id="fb-add-image"><svg><use href="#i-copy"/></svg>添加图片</button>
            <div class="fb-chips" id="fb-chips"></div>
          </div>
          <label class="fb-check"><input type="checkbox" id="fb-logs" checked />附带最近 10 分钟运行日志</label>
          <label class="fb-check"><input type="checkbox" id="fb-dumps" checked />附带崩溃转储 .dmp（未发现时自动跳过）</label>
          <div class="fb-actions">
            <button class="primary" id="fb-submit"><svg><use href="#i-launch"/></svg>提交反馈到 GitHub</button>
            <span class="fb-hint" id="fb-hint"></span>
          </div>
        </div>
      </div>
    </div>`;

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

  const checkBtn = content.querySelector<HTMLButtonElement>("#btn-check-update")!;
  checkBtn.addEventListener("click", () => {
    checkBtn.disabled = true;
    void checkForUpdates(false).finally(() => {
      checkBtn.disabled = false;
    });
  });

  // ---- 反馈中心 ----
  const fbImages: string[] = [];
  const chipsEl = content.querySelector<HTMLElement>("#fb-chips")!;
  const renderChips = (): void => {
    chipsEl.innerHTML = fbImages
      .map((p, i) => {
        const name = p.split(/[\\/]/).pop() ?? p;
        return `<span class="fb-chip" title="${esc(p)}">${esc(name)}<button data-i="${i}" title="移除">×</button></span>`;
      })
      .join("");
  };
  chipsEl.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]");
    if (btn) {
      fbImages.splice(Number(btn.dataset.i), 1);
      renderChips();
    }
  });

  content.querySelector<HTMLButtonElement>("#fb-add-image")!.addEventListener("click", () => {
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
    const includeDumps = (content.querySelector<HTMLInputElement>("#fb-dumps")!).checked;
    fbSubmitBtn.disabled = true;
    fbHint.textContent = "正在打包诊断信息…";
    void api
      .feedbackSubmit(text, fbImages.slice(), includeLogs, includeDumps)
      .then((r: FeedbackResult) => {
        const parts = [`zip：${r.zipPath.split(/[\\/]/).pop() ?? ""}`];
        if (r.dumpCount > 0) {
          parts.push(`崩溃转储 ${r.dumpCount} 个`);
        }
        if (r.imageCount > 0) {
          parts.push(`图片 ${r.imageCount} 张`);
        }
        fbHint.textContent = r.clipboardOk
          ? `Issue 页面已打开：在正文框 Ctrl+V 粘贴反馈正文，再把 ${parts.join("、")}拖入上传后提交`
          : `Issue 页面已打开（剪贴板写入失败，正文在 zip 的 issue-body.md 里手动复制）；附件：${parts.join("、")}`;
        toast("反馈包已生成，正文已复制到剪贴板", "success");
      })
      .catch((e: unknown) => {
        fbHint.textContent = "";
        toast(errText(e), "error");
      })
      .finally(() => {
        fbSubmitBtn.disabled = false;
      });
  });
}
