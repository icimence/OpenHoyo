// 从已选定的奥黛塔「芭蕾 V2」原图生成应用图标；保留构图与透明通道，不重新绘制。
// 运行：npm run icons（原图：src-tauri/icons/source.png）
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import toIco from "to-ico";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "src-tauri", "icons");
const source = join(icons, "source.png");
const android = join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");
const clear = { r: 0, g: 0, b: 0, alpha: 0 };
const ice = "#e8f4ff";
const metadata = await sharp(source).metadata();
if (!metadata.hasAlpha || metadata.width !== metadata.height) throw new Error("图标原图必须是带透明通道的正方形 PNG");

async function save(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
async function png(size) {
  return sharp(source).resize(size, size, { fit: "contain", background: clear }).png().toBuffer();
}
await save(join(icons, "icon.png"), await png(512));
await save(join(icons, "icon.ico"), await toIco(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(png))));
await save(join(root, "public", "app-icon.png"), await png(256));
await save(join(root, "public", "favicon.png"), await png(64));

for (const [density, size, foregroundSize] of [
  ["mdpi", 48, 108], ["hdpi", 72, 162], ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324], ["xxxhdpi", 192, 432],
]) {
  const dir = join(android, `mipmap-${density}`);
  await save(join(dir, "ic_launcher.png"), await png(size));
  // 圆形图标保留伸出的手与羽饰；自适应图标在 108dp 画布内预留安全边距。
  const roundArtwork = await png(Math.round(size * 0.78));
  const circle = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`);
  const round = await sharp({ create: { width: size, height: size, channels: 4, background: ice } })
    .composite([{ input: roundArtwork, gravity: "centre" }, { input: circle, blend: "dest-in" }]).png().toBuffer();
  await save(join(dir, "ic_launcher_round.png"), round);
  const foreground = await sharp({ create: { width: foregroundSize, height: foregroundSize, channels: 4, background: clear } })
    .composite([{ input: await png(Math.round(foregroundSize * 0.52)), gravity: "centre" }]).png().toBuffer();
  await save(join(dir, "ic_launcher_foreground.png"), foreground);
}
const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background" />\n    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n</adaptive-icon>\n`;
for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  await save(join(android, "mipmap-anydpi-v26", name), adaptive);
}
await save(join(android, "values", "ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${ice}</color>\n</resources>\n`);
console.info("[brand] 已生成霜舞工具箱桌面、网页和 Android 图标");
