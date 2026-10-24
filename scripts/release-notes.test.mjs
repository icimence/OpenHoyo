import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { extractChangelog } from "./extract-changelog.mjs";
import { composeNotes, recordNotes } from "./compose-release-notes.mjs";

test("missing changelog section writes zero bytes (v0.1.11 regression)", () => {
  const result = spawnSync(process.execPath, ["scripts/extract-changelog.mjs", "999.0.0"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});
test("missing and whitespace-only sections always get readable fallback notes", () => {
  for (const changelog of ["# 更新日志\n", "## v1.2.3\n \t\n## v1.2.2\n旧文案"]) {
    assert.match(composeNotes({ changelog, version: "1.2.3" }), /更新到 v1.2.3/);
  }
});
test("manual changelog takes precedence and CRLF is accepted", () => {
  assert.equal(composeNotes({ changelog: "## v1.2.3\r\n\r\n- 正式说明\r\n## v1.2.2\r\n旧文案", version: "1.2.3", gameVersion: "7.1" }), "- 正式说明");
});
test("automatic second-half release records the right characters without duplicating sections", () => {
  const notes = composeNotes({ changelog: "", version: "1.2.3", gameVersion: "7.1", phase: "second",
    events: [{ Version: "7.1", Type: 301, Order: 1, UpOrangeList: [1] }, { Version: "7.1", Type: 301, Order: 2, UpOrangeList: [2] }],
    names: { 1: "上半角色", 2: "斯柯克" } });
  assert.match(notes, /7.1下半.*斯柯克/);
  assert.doesNotMatch(notes, /上半角色/);
  for (const source of ["# 更新日志\n\n## v1.2.2\n旧文案", "# 更新日志\n\n## v1.2.3\n\t\n## v1.2.2\n旧文案"]) {
    const recorded = recordNotes(source, "1.2.3", notes);
    assert.equal(extractChangelog(recorded, "1.2.3"), notes);
    assert.equal(recordNotes(recorded, "1.2.3", notes), recorded);
    assert.equal((recorded.match(/## v1.2.3/g) ?? []).length, 1);
    assert.equal(extractChangelog(recorded, "1.2.2"), "旧文案");
  }
});
