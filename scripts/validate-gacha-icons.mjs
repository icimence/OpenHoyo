// 校验所有卡池 UP 角色/武器的本地图标；发版前运行，避免界面退化成汉字占位。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const safeFileName = (name) => name.replace(/[\\/:*?"<>|]/g, "_");

export function missingFeaturedIcons(events, names, readIcon) {
  const featured = new Map();
  for (const event of events) {
    for (const id of [...event.UpOrangeList, ...event.UpPurpleList]) {
      featured.set(id, `${event.Version} ${event.Name}`);
    }
  }

  const missing = [];
  for (const [id, event] of featured) {
    const name = names[id];
    if (!name) {
      missing.push(`${event}：物品 ${id} 缺少名称映射`);
      continue;
    }
    const data = readIcon(safeFileName(name));
    if (!data || data.length < 20 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") {
      missing.push(`${event}：${name} (${id}) 缺少有效 WebP 图标`);
    }
  }
  return { checked: featured.size, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const events = JSON.parse(readFileSync(join(root, "src-tauri", "src", "data", "gacha_events.json"), "utf8"));
  const names = JSON.parse(readFileSync(join(root, "src-tauri", "src", "data", "item_names.json"), "utf8"));
  const iconDir = join(root, "public", "gacha-icons");
  const result = missingFeaturedIcons(events, names, (name) => {
    try {
      return readFileSync(join(iconDir, `${name}.webp`));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  if (result.missing.length) {
    console.error(`卡池图标校验失败：${result.missing.length} 项缺失或损坏`);
    for (const message of result.missing) console.error(`- ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 已验证 ${result.checked} 个卡池 UP 物品图标`);
  }
}
