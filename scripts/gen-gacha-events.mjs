// 生成 gacha_events.json
//
// 分工原则（与用户确认）：
//   卡池时间 = 纯工程算术（scripts/version-table.mjs 版本表，不信任任何 API/社区数据）
//   卡池内容（UP 名单）= 米哈游官方公告 API（hk4e-api，公开无鉴权）
//   历史 UP 名单 = 沿用现有数据文件（社区来源，仅名单，时间已全部重算）
//
// 1.x 版本结构特殊（空窗/15:59 切换），整体原样保留不参与算术。
// 运行：node scripts/gen-gacha-events.mjs
// 由 .github/workflows/version-release.yml 在版本日与半池切换日（上海 04:30）调用
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSIONS, windowsFor, futureVersions } from "./version-table.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(root, "src-tauri", "src", "data");
const eventsPath = join(DATA, "gacha_events.json");
const namesPath = join(DATA, "item_names.json");

const ANN_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList" +
  "?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&channel=1&region=cn_gf01&uid=100000000";

// 上海时间
const nowLocal = new Date(Date.now() + 8 * 3600 * 1000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);
const today = nowLocal.slice(0, 10);

// ---------------------------------------------------------------------------
// 官方公告：仅提取 UP 名单与卡池名（时间一律不用）
// ---------------------------------------------------------------------------

function parseUpNames(title) {
  const ups = [...title.matchAll(/「([^」]+)」/g)].map((m) => m[1]).slice(1);
  return ups
    .map((raw) => {
      const m = raw.match(/·([^·(]+?)(?:\([^)]*\))?$/);
      return (m ? m[1] : raw).trim();
    })
    .filter((n) => n.length > 0);
}

async function fetchAnnouncements() {
  const resp = await fetch(ANN_API);
  if (!resp.ok) throw new Error(`公告 API HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.retcode !== 0) throw new Error(`公告 API retcode ${json.retcode}`);
  const anns = [];
  for (const group of json.data.list ?? []) {
    for (const a of group.list ?? []) {
      if (a.tag_label !== "扭蛋") continue;
      if (!(a.title ?? "").includes("概率UP")) continue;
      if (a.title.includes("常驻祈愿")) continue;
      anns.push({
        poolName: a.title.match(/「([^」]+)」/)?.[1] ?? "",
        type: a.title.includes("集录") ? 500 : a.title.includes("神铸赋形") ? 302 : 301,
        ups: parseUpNames(a.title),
      });
    }
  }
  return anns;
}

// ---------------------------------------------------------------------------
// 版本窗口
// ---------------------------------------------------------------------------

const futures = futureVersions(today, 2);
const allVersions = [...VERSIONS, ...futures];
const activeIdx = (() => {
  for (let i = allVersions.length - 1; i >= 0; i--) {
    if (allVersions[i].date <= today) return i;
  }
  return 0;
})();

const localToIso = (local) => local.replace(" ", "T") + "+08:00";

function windowsOf(idx) {
  return windowsFor(allVersions[idx], allVersions[idx + 1]?.date);
}

/**
 * 在线公告的挂载目标（纯算术，不用公告时间）：
 * 今天恰为某窗口开池日 → 该窗口（覆盖版本日 04:30 与半池切换日 04:30 两个触发场景）；
 * 否则 → 今天所在的窗口。
 */
function targetWindow() {
  const idx = activeIdx;
  const w = windowsOf(idx);
  const next = windowsOf(Math.min(idx + 1, allVersions.length - 1));
  if (w.firstHalf.from.slice(0, 10) === today) return { idx, half: "firstHalf", win: w.firstHalf };
  if (w.secondHalf.from.slice(0, 10) === today) return { idx, half: "secondHalf", win: w.secondHalf };
  if (next.firstHalf.from.slice(0, 10) === today) return { idx: idx + 1, half: "firstHalf", win: next.firstHalf };
  if (nowLocal >= w.secondHalf.from) return { idx, half: "secondHalf", win: w.secondHalf };
  if (nowLocal >= w.firstHalf.from) return { idx, half: "firstHalf", win: w.firstHalf };
  return { idx: idx + 1, half: "firstHalf", win: next.firstHalf };
}

// ---------------------------------------------------------------------------
// 历史 UP 名单索引：{(version, type, half) → {name, upOrange[]}}
// ---------------------------------------------------------------------------

const old = JSON.parse(readFileSync(eventsPath, "utf8"));
const oldIndex = new Map();
for (const e of old) {
  const half = e.From.includes("18:00") ? "secondHalf" : "firstHalf";
  oldIndex.set(`${e.Version}|${e.Type}|${half}`, e);
}

const nameToId = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(namesPath, "utf8"))).map(([id, name]) => [name, Number(id)]),
);

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

const announcements = await fetchAnnouncements();
console.log(`公告拉取成功：${announcements.length} 条卡池公告`);
const target = targetWindow();
console.log(
  `挂载目标：${allVersions[target.idx].version} ${target.half}（${target.win.from} ~ ${target.win.to}）`,
);

const out = [];
let fromApi = 0;
let fromHistory = 0;
let keptEarly = 0;

for (let idx = 0; idx <= activeIdx; idx++) {
  const ver = allVersions[idx];

  // 1.x：结构特殊，原样保留
  if (Number(ver.version.split(".")[0]) < 2) {
    for (const e of old.filter((x) => x.Version === ver.version)) {
      out.push(e);
      keptEarly++;
    }
    continue;
  }

  const w = windowsOf(idx);
  for (const half of ["firstHalf", "secondHalf"]) {
    const win = w[half];
    const isTarget = idx === target.idx && half === target.half;

    const plan = isTarget
      ? [
          { type: 301, name: announcements.find((a) => a.type === 301)?.poolName, ups: announcements.find((a) => a.type === 301)?.ups },
          { type: 400, name: announcements.filter((a) => a.type === 301)[1]?.poolName, ups: announcements.filter((a) => a.type === 301)[1]?.ups },
          { type: 302, name: announcements.find((a) => a.type === 302)?.poolName, ups: announcements.find((a) => a.type === 302)?.ups },
          { type: 500, name: announcements.find((a) => a.type === 500)?.poolName, ups: announcements.find((a) => a.type === 500)?.ups },
        ]
      : [301, 400, 302, 500].map((type) => {
          const rec = oldIndex.get(`${ver.version}|${type}|${half}`);
          return { type, name: rec?.Name, ups: rec ? undefined : undefined, rec };
        });

    for (const p of plan) {
      let name;
      let upOrange;
      let source;
      if (isTarget) {
        if (!p.ups || p.ups.length === 0) continue;
        name = p.name;
        upOrange = p.ups.map((n) => nameToId[n]).filter((id) => id !== undefined);
        if (upOrange.length === 0) {
          console.warn(`⚠ 公告「${name}」UP 无法映射 ID: ${p.ups.join(",")}`);
          continue;
        }
        source = "api";
        fromApi++;
      } else {
        const rec = p.rec;
        if (!rec) continue;
        name = rec.Name;
        upOrange = rec.UpOrangeList;
        source = "history";
        fromHistory++;
      }

      out.push({
        Name: name,
        Version: ver.version,
        Order: idx * 10 + (half === "firstHalf" ? 0 : 1),
        Banner: "",
        Banner2: null,
        From: localToIso(win.from),
        To: localToIso(win.to),
        Type: p.type,
        UpOrangeList: upOrange,
        UpPurpleList: [],
      });
      // 2.6 下半例外：版本维护导致 05-31 05:59 提前关池
      if (ver.version === "2.6" && half === "secondHalf") {
        out[out.length - 1].To = "2022-05-31T05:59:00+08:00";
      }
      void source;
    }
  }
}

out.sort((a, b) => (a.From === b.From ? a.Type - b.Type : a.From < b.From ? -1 : 1));

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
if (out.length < 250) throw new Error(`事件数异常: ${out.length}`);
const activeWin = windowsOf(activeIdx);
if (!(nowLocal >= activeWin.firstHalf.from && nowLocal <= activeWin.secondHalf.to)) {
  throw new Error(`活跃窗口未覆盖当前时间`);
}
// 挂载目标窗口必须有公告名单
const targetRecords = out.filter(
  (e) => e.Version === allVersions[target.idx].version &&
    e.From === localToIso(target.win.from),
);
if (targetRecords.length === 0) throw new Error("挂载目标窗口无任何记录");

// 历史锚点断言（用户口述的已验证时间，防止版本表回归）
{
  const byVer = {};
  for (const e of out) (byVer[e.Version] ??= []).push(e);
  const expect = [
    ["3.0", "2022-08-24T06:00:00+08:00", "2022-09-09T17:59:59+08:00"],
    ["3.0", "2022-09-09T18:00:00+08:00", "2022-09-27T14:59:59+08:00"],
    ["3.1", "2022-09-28T06:00:00+08:00", "2022-10-14T17:59:59+08:00"],
    ["3.1", "2022-10-14T18:00:00+08:00", "2022-11-01T14:59:59+08:00"],
    ["3.3", "2022-12-07T06:00:00+08:00", "2022-12-27T17:59:59+08:00"],
    ["3.3", "2022-12-27T18:00:00+08:00", "2023-01-17T14:59:59+08:00"],
    ["2.6", "2022-04-19T18:00:00+08:00", "2022-05-31T05:59:00+08:00"], // 白鹭之庭特例
  ];
  for (const [ver, from, to] of expect) {
    const hit = (byVer[ver] ?? []).some((e) => e.From === from && e.To === to);
    if (!hit) throw new Error(`历史锚点断言失败: ${ver} ${from} ~ ${to}`);
  }
}

writeFileSync(eventsPath, JSON.stringify(out, null, 1));
console.log(
  `✓ 生成完成：共 ${out.length} 期（公告 ${fromApi}，历史沿用 ${fromHistory}，1.x 原样 ${keptEarly}），今日 ${today}`,
);
for (const e of out.filter((x) => x.Version === allVersions[target.idx].version && x.From === localToIso(target.win.from))) {
  const names2 = e.UpOrangeList.map((id) => Object.keys(nameToId).find((k) => nameToId[k] === id) ?? id);
  console.log(`   T${e.Type} 「${e.Name}」 ${e.From.slice(0, 16)} ~ ${e.To.slice(5, 16)} UP:${names2.join(",")}`);
}
