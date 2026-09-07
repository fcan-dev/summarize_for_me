import test from "node:test";
import assert from "node:assert";
import { buildMessages, truncateText, SYSTEM_PROMPT } from "../lib/prompt.js";

test("buildMessages returns exactly system + user roles", () => {
  const msgs = buildMessages({ title: "T", siteName: "S", url: "U", text: "Hello world" }, 100000);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.ok(msgs[0].content.length > 0);
});

test("buildMessages includes title, site, url and body in the user message", () => {
  const msgs = buildMessages({ title: "My Title", siteName: "My Site", url: "https://x.test", text: "Body text here" }, 100000);
  assert.match(msgs[1].content, /My Title/);
  assert.match(msgs[1].content, /My Site/);
  assert.match(msgs[1].content, /https:\/\/x\.test/);
  assert.match(msgs[1].content, /Body text here/);
});

test("truncateText leaves short text unchanged", () => {
  const r = truncateText("abc", 10);
  assert.equal(r.truncated, false);
  assert.equal(r.text, "abc");
});

test("truncateText cuts long text and flags truncated", () => {
  const r = truncateText("1234567890", 4);
  assert.equal(r.truncated, true);
  assert.equal(r.text, "1234");
});

test("buildMessages adds a truncation note when the text is cut", () => {
  const msgs = buildMessages({ title: "", siteName: "", url: "", text: "abcdefgh" }, 3);
  assert.match(msgs[1].content, /truncated/i);
});

test("SYSTEM_PROMPT requests grounding and the three-part structure", () => {
  assert.match(SYSTEM_PROMPT, /TL;DR/);
  assert.match(SYSTEM_PROMPT, /Key points/);
  assert.match(SYSTEM_PROMPT, /Takeaway/);
  assert.match(SYSTEM_PROMPT, /quote/i);
});
