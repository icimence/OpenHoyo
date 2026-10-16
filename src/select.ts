// shadcn 风格 Select：触发器按钮 + 统一弹层（与 Combobox / DropdownMenu 共用 .sc-popover 样式），
// 替代原生 <select>（原生下拉由系统绘制，与应用内其它弹层风格不一致）。
import { closeFlyout, openFlyout } from "./flyout";

export interface SelectOption {
  value: string;
  label: string;
}

const CHEVRON = `<svg class="sc-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`;
const CHECK = `<svg class="sc-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`;

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** 触发器 HTML（放进页面模板），随后用 bindSelect 绑定行为 */
export function selectTrigger(id: string, options: SelectOption[], value: string, opts: { disabled?: boolean; cls?: string } = {}): string {
  const label = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? "";
  return `<button type="button" class="sc-select ${opts.cls ?? ""}" id="${id}" role="combobox" aria-haspopup="listbox" aria-expanded="false" ${opts.disabled ? "disabled" : ""}><span class="sc-select-value">${esc(label)}</span>${CHEVRON}</button>`;
}

export function bindSelect(trigger: HTMLButtonElement, options: SelectOption[], value: string, onChange: (value: string) => void): void {
  let current = value;
  const open = (): void => {
    const el = openFlyout(
      trigger,
      `<div role="listbox">${options
        .map(
          (o, i) =>
            `<button type="button" class="sc-item ${o.value === current ? "selected" : ""}" role="option" aria-selected="${o.value === current}" data-i="${i}"><span>${esc(o.label)}</span>${o.value === current ? CHECK : ""}</button>`,
        )
        .join("")}</div>`,
      "bottom",
      "sc-popover",
      { matchWidth: true, onClose: () => trigger.setAttribute("aria-expanded", "false") },
    );
    if (!el) {
      return;
    }
    trigger.setAttribute("aria-expanded", "true");
    const items = [...el.querySelectorAll<HTMLButtonElement>(".sc-item")];
    (items.find((b) => b.classList.contains("selected")) ?? items[0])?.focus();
    items.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        const o = options[Number(btn.dataset.i)];
        closeFlyout();
        trigger.focus();
        if (o.value !== current) {
          current = o.value;
          trigger.querySelector(".sc-select-value")!.textContent = o.label;
          onChange(o.value);
        }
      });
      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
        }
      });
    });
  };
  trigger.addEventListener("click", open);
  trigger.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      open();
    }
  });
}
