import assert from "node:assert/strict";
import test from "node:test";
import { combineLimitedOrange } from "./gacha-combined.ts";

const entry = (name, pull, is_up) => ({ name, pull, is_up, item_type: "角色", time: "2026-01-01" });

test("合并歪出的抽数到下一次限定五星，并保留未完成的大保底", () => {
  const rows = [entry("限定甲", 60, true), entry("常驻", 75, false), entry("限定乙", 9, true), entry("常驻", 12, false)];
  const combined = combineLimitedOrange(rows);
  assert.deepEqual(combined.map(({ name, pull }) => [name, pull]), [["限定甲", 60], ["限定乙", 84], ["常驻", 12]]);
  assert.deepEqual(rows.map(({ pull }) => pull), [60, 75, 9, 12]);
});
