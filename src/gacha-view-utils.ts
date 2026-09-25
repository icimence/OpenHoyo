export function iconSrc(name: string): string {
  return `/gacha-icons/${encodeURIComponent(name)}.webp`;
}

export function esc(value: string): string {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}
