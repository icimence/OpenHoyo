// 米哈游版本节奏表与卡池窗口算术
//
// 规律（社区实测 + 用户口述校准）：
// - 标准版本 42 天（6 周）：版本日 D（周三）
//   上半池 D 06:00 ~ D+20天 17:59:59，下半池 D+20天 18:00:00 ~ D+41天 14:59:59
// - 历史例外（内置于下表）：
//   1.1(44天)、2.7(62天,2.6下半 05-31 05:59 关池)、2.8(43天)、
//   3.1/3.2/3.3(35天,上半16天,下半至 D+34天 14:59)
// - 3.4 起至今严格 42 天；未来按 42 天外推，由新版本公告的 end_time 自动校准，
//   外推与公告不符时工作流告警暂停发版（兜住 2.6 式意外）
// - 1.x 早期池结构琐碎（空窗/15:59 切换），已结束版本一律沿用镜像原值，不参与算术

// 历史版本日（提取自社区镜像数据，日期为该版本最早卡池开池日）
export const VERSIONS = [
  { version: "1.0", date: "2020-09-28" },
  { version: "1.1", date: "2020-11-11" },
  { version: "1.2", date: "2020-12-23" },
  { version: "1.3", date: "2021-02-03" },
  { version: "1.4", date: "2021-03-17" },
  { version: "1.5", date: "2021-04-28" },
  { version: "1.6", date: "2021-06-09" },
  { version: "2.0", date: "2021-07-21" },
  { version: "2.1", date: "2021-09-01" },
  { version: "2.2", date: "2021-10-13" },
  { version: "2.3", date: "2021-11-24" },
  { version: "2.4", date: "2022-01-05" },
  { version: "2.5", date: "2022-02-16" },
  { version: "2.6", date: "2022-03-30" },
  { version: "2.7", date: "2022-05-31" },
  { version: "2.8", date: "2022-07-13" },
  { version: "3.0", date: "2022-08-24" },
  { version: "3.1", date: "2022-09-28" },
  { version: "3.2", date: "2022-11-02" },
  { version: "3.3", date: "2022-12-07" },
  { version: "3.4", date: "2023-01-18" },
  { version: "3.5", date: "2023-03-01" },
  { version: "3.6", date: "2023-04-12" },
  { version: "3.7", date: "2023-05-24" },
  { version: "3.8", date: "2023-07-05" },
  { version: "4.0", date: "2023-08-16" },
  { version: "4.1", date: "2023-09-27" },
  { version: "4.2", date: "2023-11-08" },
  { version: "4.3", date: "2023-12-20" },
  { version: "4.4", date: "2024-01-31" },
  { version: "4.5", date: "2024-03-13" },
  { version: "4.6", date: "2024-04-24" },
  { version: "4.7", date: "2024-06-05" },
  { version: "4.8", date: "2024-07-17" },
  { version: "5.0", date: "2024-08-28" },
  { version: "5.1", date: "2024-10-09" },
  { version: "5.2", date: "2024-11-20" },
  { version: "5.3", date: "2025-01-01" },
  { version: "5.4", date: "2025-02-12" },
  { version: "5.5", date: "2025-03-26" },
  { version: "5.6", date: "2025-05-07" },
  { version: "5.7", date: "2025-06-18" },
  { version: "5.8", date: "2025-07-30" },
  { version: "6.0", date: "2025-09-10" },
  { version: "6.1", date: "2025-10-22" },
  { version: "6.2", date: "2025-12-03" },
  { version: "6.3", date: "2026-01-14" },
  { version: "6.4", date: "2026-02-25" },
  { version: "6.5", date: "2026-04-08" },
  { version: "6.6", date: "2026-05-20" },
  { version: "6.7", date: "2026-07-01" },
  { version: "7.0", date: "2026-08-12" },
];

// 版本结构例外（默认 42 天/上半 20 天）
const STRUCT_OVERRIDES = {
  "2.7": { length: 43 },
  "3.1": { length: 35, firstHalfDays: 16 },
  "3.2": { length: 35, firstHalfDays: 16 },
  "3.3": { length: 35, firstHalfDays: 16 },
};

const DAY = 86400000;
const fmt = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => new Date(s + "T00:00:00Z");

export function structFor(version) {
  return { length: 42, firstHalfDays: 20, ...STRUCT_OVERRIDES[version] };
}

/**
 * 某版本的上下半池窗口（上海本地时间字符串，与祈愿记录 time 直接可比）
 * @param entry {version, date}
 * @param nextDate 下一版本日（yyyy-mm-dd）；缺省按结构长度推算
 * @returns {{firstHalf:{from,to}, secondHalf:{from,to}}}
 */
export function windowsFor(entry, nextDate) {
  const d = parseDate(entry.date);
  const { firstHalfDays, length } = structFor(entry.version);
  const second = new Date(d.getTime() + firstHalfDays * DAY);
  const end = nextDate
    ? new Date(parseDate(nextDate).getTime() - DAY)
    : new Date(d.getTime() + (length - 1) * DAY);
  return {
    firstHalf: {
      from: `${fmt(d)} 06:00:00`,
      to: `${fmt(second)} 17:59:59`,
    },
    secondHalf: {
      from: `${fmt(second)} 18:00:00`,
      to: `${fmt(end)} 14:59:59`,
    },
  };
}

/** 版本号递增：7.0→7.1 … 7.9→8.0 */
export function bumpVersion(v) {
  const [maj, min] = v.split(".").map(Number);
  return min === 9 ? `${maj + 1}.0` : `${maj}.${min + 1}`;
}

/**
 * 未来版本外推（自最后一个已知版本起，42 天制）
 * @param {string} today yyyy-mm-dd
 * @param {number} count 需要的未来版本数
 */
export function futureVersions(today, count) {
  const last = VERSIONS[VERSIONS.length - 1];
  const out = [];
  let version = last.version;
  let date = parseDate(last.date);
  for (let i = 0; i < count; i++) {
    date = new Date(date.getTime() + 42 * DAY);
    version = bumpVersion(version);
    out.push({ version, date: fmt(date) });
  }
  return out;
}

/** 今天（上海日期）是否为版本日（历史表或外推命中） */
export function isVersionDay(today) {
  const known = VERSIONS.some((v) => v.date === today);
  if (known) return true;
  const last = VERSIONS[VERSIONS.length - 1];
  const d = parseDate(today).getTime();
  const lastD = parseDate(last.date).getTime();
  if (d <= lastD) return false;
  return (d - lastD) % (42 * DAY) === 0;
}

/** 今天所在的活跃版本（历史表最后一个 date <= today 的版本 + 外推） */
export function activeVersion(today) {
  const d = parseDate(today);
  for (let i = VERSIONS.length - 1; i >= 0; i--) {
    if (parseDate(VERSIONS[i].date) <= d) return VERSIONS[i];
  }
  return VERSIONS[0];
}
