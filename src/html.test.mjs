import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml } from "./html.ts";

test("导入的名称不能退出 HTML 属性或插入标签", () => {
  const name = `" onpointerover="globalThis.__review_probe=1" x="'><img src=x onerror=alert(1)>`;
  assert.equal(
    escapeHtml(name),
    "&quot; onpointerover=&quot;globalThis.__review_probe=1&quot; x=&quot;&#39;&gt;&lt;img src=x onerror=alert(1)&gt;",
  );
});

test("名称中的中文、引号和已有实体保持字面含义", () => {
  assert.equal(escapeHtml(`「角色」 &lt; & "武器" '名称'`), "「角色」 &amp;lt; &amp; &quot;武器&quot; &#39;名称&#39;");
  assert.equal(escapeHtml(""), "");
});
