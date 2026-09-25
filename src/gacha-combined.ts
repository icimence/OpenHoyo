import type { OrangeEntry } from "./api";

/** 按时间从旧到新合并：歪出的抽数计入下一次限定五星。 */
export function combineLimitedOrange(entries: OrangeEntry[]): OrangeEntry[] {
  const combined: OrangeEntry[] = [];
  let pendingPulls = 0;
  let pendingLost: OrangeEntry | null = null;

  for (const entry of entries) {
    if (!entry.is_up) {
      pendingPulls += entry.pull;
      pendingLost = entry;
      continue;
    }
    combined.push({ ...entry, pull: entry.pull + pendingPulls });
    pendingPulls = 0;
    pendingLost = null;
  }

  // 最近一次五星是歪的时，保留它作为尚未完成的保底区间。
  if (pendingLost) combined.push({ ...pendingLost, pull: pendingPulls });
  return combined;
}
