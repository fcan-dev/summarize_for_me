import test from "node:test";
import assert from "node:assert";
import { CHAT_SYSTEM_PROMPT, buildChatMessages } from "../lib/prompt.js";
import { withChatTurn, clearChat } from "../lib/chat.js";

const PAGE = {
  title: "My Title",
  siteName: "My Site",
  url: "https://x.test",
  text: "The quick brown fox jumps over the lazy dog.",
};
const SUMMARY = "TL;DR: A fox jumps over a dog.";

// --- buildChatMessages (lib/prompt.js) ---

test("buildChatMessages returns system + page context + question for an empty history", () => {
  const msgs = buildChatMessages(PAGE, SUMMARY, [], "Why does the fox jump?", 100000);
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "user"]);
  assert.equal(msgs[0].content, CHAT_SYSTEM_PROMPT);
  assert.equal(msgs[2].content, "Why does the fox jump?");
});

test("the page context carries the header, article text, and the summary", () => {
  const ctx = buildChatMessages(PAGE, SUMMARY, [], "q", 100000)[1].content;
  assert.match(ctx, /My Title/);
  assert.match(ctx, /My Site/);
  assert.match(ctx, /https:\/\/x\.test/);
  assert.match(ctx, /quick brown fox/);
  assert.match(ctx, /fox jumps over a dog/);
});

test("history turns alternate user/assistant in order, before the new question", () => {
  const history = [
    { q: "First question", a: "First answer" },
    { q: "Second question", a: "Second answer" },
  ];
  const msgs = buildChatMessages(PAGE, SUMMARY, history, "Third question", 100000);
  assert.deepEqual(
    msgs.slice(2).map((m) => [m.role, m.content]),
    [
      ["user", "First question"],
      ["assistant", "First answer"],
      ["user", "Second question"],
      ["assistant", "Second answer"],
      ["user", "Third question"],
    ]
  );
});

test("a page without stored text still yields a context grounded in the summary alone", () => {
  const ctx = buildChatMessages({ title: "T", url: "U", text: "" }, SUMMARY, [], "q", 100000)[1].content;
  assert.match(ctx, /summary/i);
});

test("long article text is truncated to the cap, with a note", () => {
  const ctx = buildChatMessages({ ...PAGE, text: "abcdefgh" }, SUMMARY, [], "q", 3)[1].content;
  assert.match(ctx, /abc/);
  assert.ok(!/def/.test(ctx));
  assert.match(ctx, /truncated/i);
});

test("CHAT_SYSTEM_PROMPT demands grounding, honesty about gaps, same language, and Markdown", () => {
  assert.match(CHAT_SYSTEM_PROMPT, /ground/i);
  assert.match(CHAT_SYSTEM_PROMPT, /say so/i);
  assert.match(CHAT_SYSTEM_PROMPT, /same language/);
  assert.match(CHAT_SYSTEM_PROMPT, /markdown/i);
});

// --- chat record helpers (lib/chat.js) ---

const RECORD = {
  url: "https://x.test",
  title: "T",
  summary: "S",
  text: "THE FULL TEXT",
  createdAt: 1,
};

test("withChatTurn appends a turn and preserves text, summary, and metadata", () => {
  const next = withChatTurn(RECORD, "why?", "because", 123);
  assert.deepEqual(next.chat, [{ q: "why?", a: "because", ts: 123 }]);
  assert.equal(next.text, "THE FULL TEXT");
  assert.equal(next.summary, "S");
  assert.equal(next.url, "https://x.test");
  assert.equal(next.createdAt, 1);
});

test("withChatTurn starts the conversation from a record with no chat yet", () => {
  const next = withChatTurn({ ...RECORD, chat: undefined }, "q1", "a1", 1);
  assert.deepEqual(next.chat, [{ q: "q1", a: "a1", ts: 1 }]);
});

test("withChatTurn keeps earlier turns in order", () => {
  const next = withChatTurn({ ...RECORD, chat: [{ q: "old", a: "old-a", ts: 1 }] }, "new", "new-a", 2);
  assert.deepEqual(next.chat.map((t) => t.q), ["old", "new"]);
});

test("clearChat empties the conversation but keeps the rest of the record", () => {
  const next = clearChat({ ...RECORD, chat: [{ q: "x", a: "y", ts: 1 }] });
  assert.deepEqual(next.chat, []);
  assert.equal(next.summary, "S");
  assert.equal(next.text, "THE FULL TEXT");
});
