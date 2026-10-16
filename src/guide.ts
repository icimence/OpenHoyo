// 首次启动引导（流程对应原版 GuideView，样式参考 Langfuse 的分步配置：
// 顶部"1. xxx › 2. xxx"面包屑 + 纵向编号步骤条，已完成步骤折叠为一行摘要并可点"修改"返回，
// 当前步骤展开显示说明、表单与操作按钮，未开始的步骤置灰）。
// 步骤：0 数据文件夹 → 1 图像资源 → 2 下载 → 完成（guide_step = 4）。
// 进度持久化在后端 meta.guide_step，中途退出下次从该步继续。
import { api, errText, GUIDE_COMPLETED, type GroupProgress, type StaticStatus } from "./api";
import { downloadGroups, fmtBytes, migrateDataFolder, pickDataFolder, progressCard } from "./static-res";
import { toast } from "./ui";

/** 引导的步骤数（后端 guide_step 0..2 为进行中，4 为完成，与旧版本存储值兼容） */
const STEP_FOLDER = 0;
const STEP_IMAGES = 1;
const STEP_DOWNLOAD = 2;

const STEPS = [
  { title: "选择数据文件夹", short: "数据文件夹" },
  { title: "设置图像资源", short: "图像资源" },
  { title: "下载图像资源", short: "下载" },
];

const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`;
const FOLDER = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h4.5L8 6h6v7.5H2z"/></svg>`;

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** 引导未完成时展示，完成后 resolve；已完成直接 resolve */
export async function runGuideIfNeeded(): Promise<void> {
  let status: StaticStatus;
  try {
    status = await api.staticStatus();
  } catch (e) {
    console.warn(`[guide] 读取引导状态失败，跳过引导: ${errText(e)}`);
    return;
  }
  if (status.guide_step >= GUIDE_COMPLETED) {
    return;
  }
  console.info(`[guide] 进入首次启动引导（第 ${status.guide_step + 1} 步）`);
  await new Promise<void>((resolve) => new Guide(status, resolve).mount());
}

class Guide {
  private step: number;
  private root!: HTMLElement;
  /** 第 1 步选中的新数据目录（未确认迁移前只是"待定"） */
  private pendingDir: string | null = null;
  private migrating = false;
  /** 第 2 步：是否把官方图片保存到本地 */
  private consent: boolean;
  private selected: Set<string>;
  private progress = new Map<string, GroupProgress>();
  private downloading = false;
  private downloadFinished = false;

  constructor(
    private status: StaticStatus,
    private done: () => void,
  ) {
    // 兼容旧版本写入的步骤值（旧版 0=欢迎 1=文件夹 2=图像资源 3=下载）；下载中途退出则回到设置步重新确认
    this.step = Math.min(Math.max(status.guide_step, 0), STEP_IMAGES);
    this.consent = status.guide_step > STEP_FOLDER ? status.enabled : true;
    this.selected = new Set(status.groups.filter((g) => g.fulfilled_at === 0).map((g) => g.key));
    if (this.selected.size === 0) {
      this.selected = new Set(status.groups.map((g) => g.key));
    }
  }

  mount(): void {
    this.root = document.createElement("div");
    this.root.className = "guide-layer";
    document.getElementById("app")!.appendChild(this.root);
    this.render();
  }

  private async save(step: number): Promise<void> {
    try {
      await api.guideSetStep(step);
    } catch (e) {
      console.warn(`[guide] 保存引导进度失败: ${errText(e)}`);
    }
  }

  private async go(step: number): Promise<void> {
    this.step = step;
    await this.save(step);
    console.info(`[guide] 进入第 ${step + 1} 步：${STEPS[step]?.title ?? "完成"}`);
    this.render();
    if (step === STEP_DOWNLOAD) {
      void this.download();
    }
  }

  private async finish(): Promise<void> {
    await this.save(GUIDE_COMPLETED);
    console.info("[guide] 首次启动引导完成");
    this.root.remove();
    this.done();
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  /** 当前选择是否会进入下载步骤 */
  private get willDownload(): boolean {
    return this.consent && this.selected.size > 0;
  }

  private render(): void {
    const steps = this.willDownload || this.step === STEP_DOWNLOAD ? STEPS : STEPS.slice(0, 2);
    const crumbs = steps
      .map((s, i) => {
        const cls = i === this.step ? "current" : i < this.step ? "past" : "";
        return `<span class="guide-crumb ${cls}">${i + 1}. ${s.short}${i < this.step ? CHECK : ""}</span>`;
      })
      .join(`<span class="guide-crumb-sep">›</span>`);

    this.root.innerHTML = `
      <div class="guide-page">
        <header class="guide-header">
          <div class="guide-eyebrow">初始设置 · 第 ${this.step + 1} / ${steps.length} 步</div>
          <h1>欢迎使用胡桃工具箱</h1>
          <p>完成以下设置后即可开始使用。账号凭证与记录只保存在你的电脑上，游戏图片只来自米哈游官方服务器；这些设置之后都能在「设置」页修改。</p>
          <nav class="guide-crumbs" aria-label="设置步骤">${crumbs}</nav>
        </header>
        <ol class="guide-stepper">
          ${steps.map((s, i) => this.stepHtml(i, s.title)).join("")}
        </ol>
      </div>`;
    this.bind();
  }

  private stepHtml(i: number, title: string): string {
    const state = i < this.step ? "complete" : i === this.step ? "current" : "upcoming";
    const marker = state === "complete" ? CHECK : String(i + 1);
    const canEdit = state === "complete" && !this.downloading && !this.migrating;
    return `
      <li class="guide-item ${state}">
        <div class="guide-rail"><span class="guide-num">${marker}</span><span class="guide-line"></span></div>
        <div class="guide-item-main">
          <div class="guide-item-head">
            <span class="guide-item-title">${title}</span>
            ${state === "complete" ? `<span class="guide-badge">已完成</span>` : ""}
            ${state === "current" ? `<span class="guide-badge current">进行中</span>` : ""}
            ${canEdit ? `<button class="guide-edit" data-edit="${i}">修改</button>` : ""}
          </div>
          ${state === "complete" ? `<div class="guide-summary">${this.summary(i)}</div>` : ""}
          ${state === "upcoming" ? `<div class="guide-summary muted">${this.upcomingHint(i)}</div>` : ""}
          ${state === "current" ? `<div class="guide-item-body">${this.body(i)}</div>` : ""}
        </div>
      </li>`;
  }

  private summary(i: number): string {
    if (i === STEP_FOLDER) {
      return `${this.status.is_default_dir ? "使用默认位置" : "使用自定义位置"}：<code>${esc(this.status.data_dir)}</code>`;
    }
    if (i === STEP_IMAGES) {
      if (!this.consent) {
        return "不保存到本地，每次在线加载";
      }
      const names = this.status.groups.filter((g) => this.selected.has(g.key)).map((g) => g.name);
      return `保存到本地${names.length ? `，首次下载：${names.map(esc).join("、")}` : "，暂不下载"}`;
    }
    return "";
  }

  private upcomingHint(i: number): string {
    return i === STEP_IMAGES ? "选择是否把游戏图片保存到本地" : "按上一步的选择下载图片，可随时跳过";
  }

  private body(i: number): string {
    switch (i) {
      case STEP_FOLDER:
        return this.folderBody();
      case STEP_IMAGES:
        return this.imagesBody();
      case STEP_DOWNLOAD:
        return this.downloadBody();
      default:
        return "";
    }
  }

  private folderBody(): string {
    const cur = esc(this.status.data_dir);
    const pending = this.pendingDir ? esc(this.pendingDir) : null;
    const target = pending
      ? `
        <div class="guide-field">
          <div class="guide-label">新位置</div>
          <div class="guide-path changed">${FOLDER}<code>${pending}</code><span class="guide-tag">待迁移</span></div>
        </div>
        <div class="guide-callout">
          <b>点击「迁移并重启」后：</b>
          <ol>
            <li>把当前的账号、祈愿记录、挑战记录和已下载的图片<b>复制</b>到新位置</li>
            <li>应用自动重启，从新位置读取数据，并回到这一步</li>
            <li>确认新位置可用后，才会删除旧位置的数据</li>
          </ol>
          <p>迁移期间请勿关闭应用；如果同时开着另一个胡桃工具箱（例如已安装的版本），请先把它关掉。</p>
        </div>`
      : "";
    const actions = pending
      ? `<button id="g-cancel-dir" ${this.migrating ? "disabled" : ""}>取消</button>
         <button class="primary" id="g-migrate" ${this.migrating ? "disabled" : ""}>${this.migrating ? "正在迁移…" : "迁移并重启"}</button>`
      : `<button id="g-pick">${this.status.is_default_dir ? "更改位置…" : "重新选择…"}</button>
         <button class="primary" id="g-next">使用此位置，继续</button>`;
    return `
      <p class="guide-desc">数据文件夹保存账号凭证、祈愿记录、挑战记录，以及下载到本地的游戏图片。默认位置在卸载时会被一同删除；如果你想长期保留，建议选一个自己的文件夹。</p>
      <div class="guide-field">
        <div class="guide-label">${pending ? "当前位置" : this.status.is_default_dir ? "当前位置（默认）" : "当前位置（自定义）"}</div>
        <div class="guide-path">${FOLDER}<code>${cur}</code></div>
      </div>
      ${target}
      <div class="guide-actions">${actions}</div>`;
  }

  private imagesBody(): string {
    const groups = this.status.groups
      .map(
        (g) => `
        <label class="sc-check ${this.consent ? "" : "disabled"}">
          <input type="checkbox" data-group="${g.key}" ${this.selected.has(g.key) ? "checked" : ""} ${this.consent ? "" : "disabled"}/>
          <span><b>${esc(g.name)}${g.fulfilled_at ? `<em class="guide-tag ok">已下载</em>` : ""}</b><small>${esc(g.description)}</small></span>
        </label>`,
      )
      .join("");
    const next = this.willDownload ? "下一步：开始下载" : "完成设置";
    return `
      <p class="guide-desc">角色、武器、技能、圣遗物等图片默认每次都从米哈游官方服务器加载。保存到本地后，离线也能显示，切换页面更快。</p>
      <div class="guide-choice" role="radiogroup">
        <label class="sc-radio ${this.consent ? "checked" : ""}">
          <input type="radio" name="g-consent" value="1" ${this.consent ? "checked" : ""}/>
          <span><b>保存到本地（推荐）</b><small>先下载常用图片；之后浏览时遇到的新图片也会自动保存</small></span>
        </label>
        <label class="sc-radio ${this.consent ? "" : "checked"}">
          <input type="radio" name="g-consent" value="0" ${this.consent ? "" : "checked"}/>
          <span><b>不保存，每次在线加载</b><small>不占用磁盘空间，图片显示速度取决于网络</small></span>
        </label>
      </div>
      <div class="guide-field">
        <div class="guide-label">首次下载哪些图片${this.consent ? "" : "（需先选择「保存到本地」）"}</div>
        <div class="guide-groups">${groups}</div>
      </div>
      <p class="guide-hint">图片保存在：<code>${esc(this.status.data_dir)}\\static</code></p>
      <div class="guide-actions">
        <button id="g-back">上一步</button>
        <button class="primary" id="g-next">${next}</button>
      </div>`;
  }

  private downloadBody(): string {
    const groups = this.status.groups.filter((g) => this.selected.has(g.key));
    const total = [...this.progress.values()].reduce((s, p) => s + p.bytes, 0);
    const failed = [...this.progress.values()].reduce((s, p) => s + p.failed, 0);
    const result = this.downloadFinished
      ? `<div class="guide-callout ${failed > 0 ? "warn" : "ok"}">${
          failed > 0
            ? `下载结束，共 ${fmtBytes(total)}；有 ${failed} 个文件没下载成功，图片将要显示时会自动补全，无需处理。`
            : `下载完成，共 ${fmtBytes(total)}。`
        }</div>`
      : "";
    return `
      <p class="guide-desc">正在从米哈游官方服务器下载图片。可以随时跳过，没下载的图片会在浏览时按需加载。</p>
      <div class="sr-progress-list" id="g-progress">${groups.map((g) => progressCard(esc(g.name), this.progress.get(g.key))).join("")}</div>
      ${result}
      <div class="guide-actions">
        ${this.downloading ? `<button id="g-skip">跳过</button>` : `<button class="primary" id="g-finish">开始使用</button>`}
      </div>`;
  }

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  private bind(): void {
    const $ = <T extends HTMLElement>(sel: string): T | null => this.root.querySelector<T>(sel);

    this.root.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) => {
      b.addEventListener("click", () => void this.go(Number(b.dataset.edit)));
    });
    $("#g-back")?.addEventListener("click", () => void this.go(this.step - 1));
    $("#g-finish")?.addEventListener("click", () => void this.finish());
    $("#g-skip")?.addEventListener("click", () => void api.staticCancel());

    // 第 1 步：选目录只记为"待迁移"，用户看到新路径并确认后才真正迁移
    $("#g-pick")?.addEventListener("click", () => {
      void pickDataFolder().then((path) => {
        if (path) {
          console.info("[guide] 已选择新的数据目录，等待确认迁移");
          this.pendingDir = path;
          this.render();
        }
      });
    });
    $("#g-cancel-dir")?.addEventListener("click", () => {
      this.pendingDir = null;
      this.render();
    });
    $("#g-migrate")?.addEventListener("click", () => {
      if (!this.pendingDir) {
        return;
      }
      this.migrating = true;
      this.render();
      const target = this.pendingDir;
      // 先把进度定在本步再迁移：重启后从新位置读到的仍是这一步，用户可以核对新路径后再继续
      void this.save(STEP_FOLDER)
        .then(() => migrateDataFolder(target))
        .then((ok) => {
          if (!ok) {
            this.migrating = false;
            this.render();
          }
        });
    });

    this.root.querySelectorAll<HTMLInputElement>('input[name="g-consent"]').forEach((r) => {
      r.addEventListener("change", () => {
        this.consent = r.value === "1";
        this.render();
      });
    });
    this.root.querySelectorAll<HTMLInputElement>("input[data-group]").forEach((c) => {
      c.addEventListener("change", () => {
        if (c.checked) {
          this.selected.add(c.dataset.group!);
        } else {
          this.selected.delete(c.dataset.group!);
        }
        this.render();
      });
    });

    $("#g-next")?.addEventListener("click", () => {
      if (this.step === STEP_FOLDER) {
        void this.go(STEP_IMAGES);
        return;
      }
      void (async () => {
        try {
          await api.staticSetEnabled(this.consent);
        } catch (e) {
          toast(errText(e), "error");
          return;
        }
        console.info(`[guide] 图像资源：${this.consent ? `保存到本地，首次下载 ${[...this.selected].join(",") || "无"}` : "不保存"}`);
        if (this.willDownload) {
          await this.go(STEP_DOWNLOAD);
        } else {
          await this.finish();
        }
      })();
    });
  }

  private async download(): Promise<void> {
    this.downloading = true;
    this.downloadFinished = false;
    this.render();
    const groups = this.status.groups.filter((g) => this.selected.has(g.key));
    const repaint = (): void => {
      const holder = this.root.querySelector("#g-progress");
      if (holder) {
        holder.innerHTML = groups.map((g) => progressCard(esc(g.name), this.progress.get(g.key))).join("");
      }
    };
    try {
      const results = await downloadGroups(
        groups.map((g) => g.key),
        (p) => {
          this.progress.set(p.key, p);
          repaint();
        },
      );
      for (const r of results) {
        this.progress.set(r.key, r);
      }
    } catch (e) {
      toast(`图像资源下载失败：${errText(e)}`, "error");
    } finally {
      this.downloading = false;
      this.downloadFinished = true;
      this.render();
    }
  }
}
