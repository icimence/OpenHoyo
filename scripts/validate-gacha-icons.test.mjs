import assert from "node:assert/strict";
import test from "node:test";
import { missingFeaturedIcons } from "./validate-gacha-icons.mjs";

const webp = Buffer.concat([Buffer.from("RIFF0000WEBP"), Buffer.alloc(8)]);

test("release gate reports missing featured portraits and name mappings", () => {
  const events = [{ Version: "7.1", Name: "活动祈愿", UpOrangeList: [1001, 1002], UpPurpleList: [1003] }];
  const names = { 1001: "已有头像", 1002: "缺失头像" };
  const result = missingFeaturedIcons(events, names, (name) => name === "已有头像" ? webp : null);
  assert.equal(result.checked, 3);
  assert.equal(result.missing.length, 2);
  assert.match(result.missing[0], /缺失头像/);
  assert.match(result.missing[1], /1003.*缺少名称映射/);
});
