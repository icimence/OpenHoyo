// 所有发布入口使用同一份非空用户文案；自动卡池发布先把文案记入 CHANGELOG.md。
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { extractChangelog } from "./extract-changelog.mjs";

export function automaticNotes(gameVersion, phase, events, names) {
  const pools = events.filter((event) => event.Version === gameVersion && [301, 400].includes(event.Type));
  const orders = pools.map((event) => event.Order);
  const order = phase === "second" ? Math.max(...orders) : Math.min(...orders);
  const characters = [...new Set(pools.filter((event) => event.Order === order)
    .flatMap((event) => event.UpOrangeList).map((id) => names[id]).filter(Boolean))];
  const half = phase === "second" ? "下半" : phase === "first" ? "上半" : "";
  return `- 祈愿记录已同步原神 ${gameVersion}${half}卡池信息${characters.length ? `，可查看${characters.join("、")}等角色的当期祈愿与统计` : ""}。\n- 卡池物品的名称与图标已同步，查看祈愿记录时更容易识别。`;
}

export function composeNotes({ changelog, version, gameVersion, phase, events = [], names = {} }) {
  return extractChangelog(changelog, version)
    || (gameVersion ? automaticNotes(gameVersion, phase, events, names) : `更新到 v${version}，修复了一些问题并优化了使用体验。`);
}

export function recordNotes(changelog, version, notes) {
  if (extractChangelog(changelog, version)) return changelog;
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## v${version}`);
  if (start >= 0) {
    const next = lines.findIndex((line, i) => i > start && /^## /.test(line));
    lines.splice(start, (next < 0 ? lines.length : next) - start, `## v${version}`, "", notes, "");
    return lines.join("\n");
  }
  const index = changelog.search(/^## /m);
  const at = index < 0 ? changelog.length : index;
  return `${changelog.slice(0, at).trimEnd()}\n\n## v${version}\n\n${notes}\n\n${changelog.slice(at)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    version: { type: "string" }, "game-version": { type: "string" }, phase: { type: "string" },
    output: { type: "string" }, record: { type: "boolean" }, "github-output": { type: "boolean" },
  } });
  if (!/^\d+\.\d+\.\d+$/.test(values.version ?? "")) throw new Error("需要 --version x.y.z");
  if (values.phase && !["first", "second"].includes(values.phase)) throw new Error("phase 必须是 first 或 second");
  if (values.record && !values["game-version"]) throw new Error("只有自动卡池发布可以生成 CHANGELOG 段落");
  const root = new URL("../", import.meta.url);
  const path = new URL("CHANGELOG.md", root);
  const changelog = readFileSync(path, "utf8");
  const notes = composeNotes({ changelog, version: values.version, gameVersion: values["game-version"], phase: values.phase,
    events: JSON.parse(readFileSync(new URL("src-tauri/src/data/gacha_events.json", root), "utf8")),
    names: JSON.parse(readFileSync(new URL("src-tauri/src/data/item_names.json", root), "utf8")),
  });
  if (!notes.trim()) throw new Error("更新说明不能为空");
  if (values.record) writeFileSync(path, recordNotes(changelog, values.version, notes));
  if (values.output) {
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, `${notes}\n`);
  }
  if (values["github-output"]) {
    const delimiter = `notes_${randomUUID()}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `body<<${delimiter}\n${notes}\n${delimiter}\n`);
  }
  process.stdout.write(`${notes}\n`);
}
