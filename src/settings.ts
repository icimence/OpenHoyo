// 设置页：主题切换（跟随系统/浅色/深色）、当前版本号与手动检查更新
import { checkForUpdates } from "./updater";

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
}
