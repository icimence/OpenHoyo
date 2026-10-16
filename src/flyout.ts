// 轻量弹层（对应 WinUI Flyout / shadcn Popover）：锚定元素弹出，点外部或 Esc 关闭。
// 同一时刻只保留一个，打开新的会先关闭旧的。

export type FlyoutPlacement = "bottom" | "bottom-end" | "left" | "right";

export interface FlyoutOptions {
  /** 按钮类锚点为 true：再次点同一锚点则收起；输入联想等需要原地刷新的场景传 false */
  toggle?: boolean;
  /** 最小宽度与锚点一致（Select / Combobox 下拉） */
  matchWidth?: boolean;
  /** 关闭时回调（无论何种方式关闭） */
  onClose?: () => void;
}

let current: { el: HTMLElement; anchor: HTMLElement; placement: FlyoutPlacement; dispose: () => void } | null = null;

export function closeFlyout(): void {
  const c = current;
  current = null;
  c?.dispose();
}

/** 锚点尺寸变化（如筛选框换行）后重新定位当前弹层 */
export function repositionFlyout(): void {
  if (current) {
    position(current.el, current.anchor, current.placement);
  }
}

/** 在 anchor 旁弹出 html；返回弹层元素以便调用方绑定内部事件（被收起时返回 null）。 */
export function openFlyout(
  anchor: HTMLElement,
  html: string,
  placement: FlyoutPlacement = "bottom",
  cls = "",
  opts: FlyoutOptions = {},
): HTMLElement | null {
  if ((opts.toggle ?? true) && current?.anchor === anchor) {
    closeFlyout();
    return null;
  }
  closeFlyout();
  const el = document.createElement("div");
  el.className = `flyout ${cls}`.trim();
  el.innerHTML = html;
  if (opts.matchWidth) {
    el.style.minWidth = `${Math.round(anchor.getBoundingClientRect().width)}px`;
  }
  document.body.appendChild(el);
  position(el, anchor, placement);

  const onDown = (ev: MouseEvent): void => {
    const t = ev.target as Node;
    if (!el.contains(t) && !anchor.contains(t)) {
      closeFlyout();
    }
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      closeFlyout();
    }
  };
  const onScroll = (ev: Event): void => {
    if (!el.contains(ev.target as Node)) {
      closeFlyout();
    }
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closeFlyout);
  current = {
    el,
    anchor,
    placement,
    dispose: () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", closeFlyout);
      opts.onClose?.();
      el.remove();
    },
  };
  return el;
}

/** 菜单式弹层（对应 shadcn DropdownMenu）：点击菜单项后自动关闭 */
export function openMenuFlyout(
  anchor: HTMLElement,
  items: { label: string; disabled?: boolean; title?: string; onClick: () => void }[],
  placement: FlyoutPlacement = "bottom",
): void {
  const el = openFlyout(
    anchor,
    items
      .map(
        (it, i) =>
          `<button type="button" class="sc-item" role="menuitem" data-i="${i}" ${it.disabled ? "disabled" : ""} ${it.title ? `title="${it.title}"` : ""}>${it.label}</button>`,
      )
      .join(""),
    placement,
    "sc-popover",
  );
  el?.querySelectorAll<HTMLButtonElement>(".sc-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const it = items[Number(btn.dataset.i)];
      closeFlyout();
      it.onClick();
    });
  });
}

function position(el: HTMLElement, anchor: HTMLElement, placement: FlyoutPlacement): void {
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const gap = 4;
  let left: number;
  let top: number;
  switch (placement) {
    case "left":
      left = a.left - r.width - gap;
      top = a.top;
      break;
    case "right":
      left = a.right + gap;
      top = a.top;
      break;
    case "bottom-end":
      left = a.right - r.width;
      top = a.bottom + gap;
      break;
    default:
      left = a.left;
      top = a.bottom + gap;
  }
  // 约束在窗口内（对应 ShouldConstrainToRootBounds）
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (left + r.width > vw - 8) {
    left = vw - 8 - r.width;
  }
  if (left < 8) {
    left = 8;
  }
  if (top + r.height > vh - 8) {
    top = placement === "left" || placement === "right" ? vh - 8 - r.height : a.top - r.height - gap;
  }
  if (top < 8) {
    top = 8;
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
