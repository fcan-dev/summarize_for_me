# Page Summarizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome extension that, in one toolbar-icon click, summarizes the open page (via Readability) with a grounded, structured, streamed summary from a user-configurable OpenAI-compatible endpoint, shown in Chrome's side panel.

**Architecture:** Four runtime parts: a classic **content script** (Readability extraction), an ES-module **background service worker** (tab/extract relay + streaming SSE fetch), a **side panel** (settings + streaming markdown UI), and two **pure Node-tested modules** (`lib/sse.js`, `lib/prompt.js`). The side panel drives the pipeline after it opens; background exposes small message ops.

**Tech Stack:** Manifest V3, vanilla JS, Chrome APIs (`sidePanel`, `storage`, `tabs`, `action`), Mozilla Readability, marked, DOMPurify (all bundled locally). Tests: Node built-in `node --test` (no deps). Icons: Python PIL.

**Spec:** `docs/superpowers/specs/2026-09-04-page-summarizer-design.md`

## Global Constraints

- **Manifest V3.** No MV2 patterns.
- **Module format:** `background.js` and `lib/*.js` are **ES modules** (service worker declared `"type": "module"`). `content.js` and `sidepanel.js` are **classic scripts** (no `import`/`export`).
- **Permissions exactly:** `"permissions": ["storage", "sidePanel", "activeTab"]`; `"host_permissions": ["<all_urls>"]`.
- **LLM contract:** `POST {baseUrl}/chat/completions`, header `Authorization: Bearer {apiKey}`, body uses `stream: true` and `max_tokens` (NOT `max_completion_tokens`). Roles: `system`/`user`/`assistant` only — **no** `developer` role, **no** reasoning-effort fields.
- **Defaults:** `baseUrl`=`http://<redacted-lan-ip>:8090/v1`, `apiKey`=`local`, `model`=`qwen3.8-27b`, `maxTokens`=`2048`, `temperature`=`0.3`, `maxInputChars`=`100000`.
- **Output:** Markdown with `**TL;DR**`, `**Key points**` (bullets), `**Takeaway**`, grounded with `"double-quoted"` snippets.
- **No CDN at runtime** — all libraries are bundled under `vendor/`.
- **Test command:** `node --test tests/` (Node built-in runner; ES modules via `"type":"module"` in package.json).

**How to load the unpacked extension** (used by several tasks): open `chrome://extensions`, enable **Developer mode** (top-right), click **Load unpacked**, select the `chrome_extension_summarize/` folder. After editing files, click the reload (↻) icon on the extension card.

---

### Task 1: Scaffold project, test harness, vendor libs, icons, manifest

**Files:**
- Create: `.gitignore`, `package.json`, `manifest.json`
- Create: `vendor/Readability.js`, `vendor/marked.min.js`, `vendor/DOMPurify.min.js`
- Create: `scripts/make_icons.py`, `icons/16.png`, `icons/32.png`, `icons/48.png`, `icons/128.png`
- Create: `lib/.gitkeep`, `tests/smoke.test.js`
- Create (stubs): `background.js`, `content.js`, `sidepanel.html`, `sidepanel.css`

**Interfaces:**
- Produces: loadable extension skeleton; `node --test tests/` passing; vendor globals available for later tasks (`Readability`, `marked`, `DOMPurify`); icon files referenced by `manifest.json`.

- [ ] **Step 1: Create `.gitignore`**

```bash
mkdir -p lib tests scripts icons vendor
```
Write `.gitignore`:
```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "page-summarizer",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 3: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Page Summarizer",
  "version": "1.0.0",
  "description": "One-click grounded page summaries in the side panel.",
  "permissions": ["storage", "sidePanel", "activeTab"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": {
    "default_title": "Summarize page",
    "default_icon": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" }
  },
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["vendor/Readability.js", "content.js"], "run_at": "document_idle" }
  ]
}
```

- [ ] **Step 4: Download vendor libraries (bundle locally)**

```bash
curl -fsSL "https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.min.js" -o vendor/Readability.js
curl -fsSL "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js" -o vendor/marked.min.js
curl -fsSL "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js" -o vendor/DOMPurify.min.js
ls -l vendor/
```
Expected: three `.js` files, each several KB (non-zero size). If any is 0 bytes, re-run that curl.

- [ ] **Step 5: Write `scripts/make_icons.py` and generate icons**

Write `scripts/make_icons.py`:
```python
from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]

def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = max(2, size // 6)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(37, 99, 235, 255))
    pad = size // 4
    bar_h = max(1, size // 10)
    gap = bar_h
    widths = [size - 2 * pad, size - 2 * pad, int((size - 2 * pad) * 0.6)]
    y = pad
    for w in widths:
        d.rounded_rectangle([pad, y, pad + w, y + bar_h - 1], radius=bar_h // 2, fill=(255, 255, 255, 255))
        y += bar_h + gap
    img.save(f"icons/{size}.png")

for s in SIZES:
    make(s)
print("icons generated")
```
Run: `python3 scripts/make_icons.py`
Expected: prints `icons generated`; `ls icons/` shows `16.png 32.png 48.png 128.png`.

- [ ] **Step 6: Create runtime stubs + a smoke test**

Write `lib/.gitkeep` (empty file).
Write `background.js` (stub):
```js
// background.js — MV3 service worker (ES module). Implemented in Task 5.
```
Write `content.js` (stub):
```js
// content.js — Readability extraction. Implemented in Task 4.
```
Write `sidepanel.css` (stub):
```css
/* side panel styles. Implemented in Task 6. */
```
Write `sidepanel.html` (minimal valid stub so the manifest reference resolves):
```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><link rel="stylesheet" href="sidepanel.css"></head>
<body><p>Page Summarizer</p></body>
</html>
```
Write `tests/smoke.test.js`:
```js
import test from "node:test";
import assert from "node:assert";

test("test harness works", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 7: Run tests to verify the harness passes**

Run: `node --test tests/`
Expected: PASS (1 test: "test harness works").

- [ ] **Step 8: Verify the skeleton loads in Chrome**

Load the unpacked extension (see instructions above). Expected: it loads with no errors on the extension card (the service-worker stub and content-script stub are no-ops, so no console errors on a web page).

- [ ] **Step 9: Commit**

```bash
git add .gitignore package.json manifest.json vendor/ scripts/ icons/ lib/.gitkeep tests/smoke.test.js background.js content.js sidepanel.css sidepanel.html
git commit -m "chore: scaffold extension, vendor libs, icons, manifest, test harness"
```

---

### Task 2: Pure SSE parser (`lib/sse.js`) — TDD

**Files:**
- Create: `lib/sse.js`
- Test: `tests/sse.test.js`

**Interfaces:**
- Produces (used by `background.js` in Task 5):
  - `extractDataPayloads(buffer: string) → { payloads: string[], rest: string }` — splits a raw SSE text buffer into complete `data:` payload strings; carries an incomplete trailing line in `rest`.
  - `tokenFromPayload(payload: string) → { done: boolean, token: string }` — `[DONE]` → `{done:true,token:""}`; else parses JSON and returns `choices[0].delta.content` (or `""`).

- [ ] **Step 1: Write the failing tests**

Write `tests/sse.test.js`:
```js
import test from "node:test";
import assert from "node:assert";
import { extractDataPayloads, tokenFromPayload } from "../lib/sse.js";

test("extractDataPayloads parses complete data lines", () => {
  const { payloads, rest } = extractDataPayloads('data: {"a":1}\ndata: {"b":2}\n');
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, "");
});

test("extractDataPayloads carries an incomplete trailing line as rest", () => {
  const { payloads, rest } = extractDataPayloads('data: {"a":1}\ndata: {"b":');
  assert.deepEqual(payloads, ['{"a":1}']);
  assert.equal(rest, 'data: {"b":');
});

test("extractDataPayloads ignores non-data and blank lines", () => {
  const { payloads } = extractDataPayloads('event: message\n\n: comment\ndata: {"a":1}\n');
  assert.deepEqual(payloads, ['{"a":1}']);
});

test("tokenFromPayload returns the content token", () => {
  const { done, token } = tokenFromPayload('{"choices":[{"delta":{"content":"Hel"}}]}');
  assert.equal(done, false);
  assert.equal(token, "Hel");
});

test("tokenFromPayload handles [DONE]", () => {
  assert.deepEqual(tokenFromPayload("[DONE]"), { done: true, token: "" });
});

test("tokenFromPayload returns empty when delta.content is absent", () => {
  const { done, token } = tokenFromPayload('{"choices":[{"delta":{}}]}');
  assert.equal(done, false);
  assert.equal(token, "");
});

test("tokenFromPayload returns empty for malformed JSON", () => {
  const { done, token } = tokenFromPayload("not json");
  assert.equal(done, false);
  assert.equal(token, "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/sse.test.js`
Expected: FAIL — `Cannot find module '.../lib/sse.js'` (or `extractDataPayloads is not a function`).

- [ ] **Step 3: Write the implementation**

Write `lib/sse.js`:
```js
// Pure SSE parsing helpers. No DOM, no fetch. Testable in Node.

// Splits a raw SSE text buffer into complete `data:` payload strings.
// An incomplete trailing line (buffer not ending in "\n") is returned as `rest`.
export function extractDataPayloads(buffer) {
  const payloads = [];
  const lines = buffer.split("\n");
  let rest = "";
  if (!buffer.endsWith("\n")) {
    rest = lines.pop() ?? "";
  }
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload !== "") payloads.push(payload);
  }
  return { payloads, rest };
}

// Interprets a single data payload: [DONE] sentinel or a chat-completion chunk.
export function tokenFromPayload(payload) {
  if (payload === "[DONE]") return { done: true, token: "" };
  try {
    const obj = JSON.parse(payload);
    const token = obj?.choices?.[0]?.delta?.content ?? "";
    return { done: false, token };
  } catch {
    return { done: false, token: "" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/sse.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/sse.js tests/sse.test.js
git commit -m "feat: pure SSE chunk parser with tests"
```

---

### Task 3: Pure prompt builder (`lib/prompt.js`) — TDD

**Files:**
- Create: `lib/prompt.js`
- Test: `tests/prompt.test.js`

**Interfaces:**
- Produces (used by `background.js` in Task 5):
  - `SYSTEM_PROMPT: string` — the summarization system prompt.
  - `truncateText(text: string, maxChars: number) → { text: string, truncated: boolean }`
  - `buildMessages(page: { title, siteName, url, text }, maxInputChars: number) → Array<{ role: "system" | "user", content: string }>` — returns exactly two messages (system, user); user message = optional Title/Site/URL header (+ truncation note) + article text.

- [ ] **Step 1: Write the failing tests**

Write `tests/prompt.test.js`:
```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/prompt.test.js`
Expected: FAIL — `Cannot find module '.../lib/prompt.js'`.

- [ ] **Step 3: Write the implementation**

Write `lib/prompt.js`:
```js
// Pure prompt/message building. No DOM. Testable in Node.

export const SYSTEM_PROMPT = [
  "You are a precise summarization assistant.",
  "Summarize ONLY the article text provided by the user.",
  'Ground your summary in the source: include a few short verbatim quotes (in "double quotes") that support the key points.',
  "Respond in Markdown with exactly three parts, in order:",
  "1. **TL;DR** - one or two sentences.",
  "2. **Key points** - a bulleted list.",
  "3. **Takeaway** - a single line.",
  "Match the depth to the length and substance of the content: keep it brief for short or thin pages, and be more detailed for long, rich ones.",
  "If the source is thin, keep the summary brief and say so.",
  "Output only the summary - no preamble, no commentary.",
].join("\n");

export function truncateText(text, maxChars) {
  if (maxChars == null || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export function buildMessages(page, maxInputChars) {
  const { text, truncated } = truncateText(page?.text || "", maxInputChars);
  const lines = [];
  if (page?.title) lines.push(`Title: ${page.title}`);
  if (page?.siteName) lines.push(`Site: ${page.siteName}`);
  if (page?.url) lines.push(`URL: ${page.url}`);
  if (truncated) lines.push("(Note: the source text was truncated to fit the model.)");
  lines.push("", "Article text:", "");
  const header = lines.join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${header}\n${text}` },
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/prompt.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full test suite**

Run: `node --test tests/`
Expected: PASS (smoke + sse + prompt = 14 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/prompt.js tests/prompt.test.js
git commit -m "feat: pure prompt/message builder with tests"
```

---

### Task 4: Content script — Readability extraction (`content.js`)

**Files:**
- Modify (replace stub): `content.js`

**Interfaces:**
- Consumes: global `Readability` (loaded by the manifest before `content.js`); message `{ type: "EXTRACT" }` from `background.js`.
- Produces: a response object to the `EXTRACT` message:
  `{ ok: true, title, siteName, byline, url, text, charCount, source }` where `source` is `"readability"` or `"body"`; or `{ ok: false, error }` with `error` = `"little-text"` (too little content) or a message string.

- [ ] **Step 1: Write `content.js`**

Replace the stub `content.js` with:
```js
// content.js — page-text extraction via Readability (classic script, no modules).
(function () {
  const MIN_CHARS = 200;
  const MAX_CHARS = 100000; // hard cap; the configurable cap is applied again in lib/prompt.js

  function capText(text) {
    return text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS);
  }

  function extract() {
    try {
      const clone = document.cloneNode(true);
      const article = new Readability(clone, { charThreshold: MIN_CHARS }).parse();

      let text = "";
      let source = "";
      const articleText = (article && article.textContent) || "";
      if (articleText.trim().length >= MIN_CHARS) {
        text = articleText.trim();
        source = "readability";
      } else {
        text = ((document.body && document.body.innerText) || "").trim();
        source = "body";
      }

      if (text.length < MIN_CHARS) return { ok: false, error: "little-text" };

      text = capText(text);
      console.debug("[page-summarizer] extracted", text.length, "chars, source:", source);
      return {
        ok: true,
        title: (article && article.title) || document.title,
        siteName: (location.hostname || "").replace(/^www\./, ""),
        byline: (article && article.byline) || "",
        url: location.href,
        text,
        charCount: text.length,
        source,
      };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "extraction failed" };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "EXTRACT") {
      sendResponse(extract());
    }
  });
})();
```

- [ ] **Step 2: Manual test — verify extraction works on a real page**

1. Load/reload the unpacked extension.
2. Open a content-rich article in a normal tab (e.g. https://www.bbc.com/news or any long blog post).
3. Open DevTools (F12) → **Console**.
4. Trigger extraction from the console is not directly possible (content script is an isolated world), so instead verify indirectly: this content script only logs on message. To confirm it registers without error, open a fresh article tab and confirm **no red errors** attributed to `content.js` in the Console.
5. (Functional extraction is fully verified end-to-end in Task 7; here we confirm the script loads and defines the listener without throwing.)

Expected: no `content.js` errors in the Console.

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: content script extracts page text via Readability"
```

---

### Task 5: Background service worker (`background.js`)

**Files:**
- Modify (replace stub): `background.js`

**Interfaces:**
- Consumes: `lib/sse.js` (`extractDataPayloads`, `tokenFromPayload`), `lib/prompt.js` (`buildMessages`); content-script `EXTRACT` response from Task 4.
- Produces:
  - `chrome.action.onClicked` → opens the side panel for the tab's window.
  - Message handler (via `chrome.runtime.sendMessage`, resolved with a single `sendResponse`):
    - `{ type: "GET_TAB" }` → `{ tabId, url, title }` or `{ error }`.
    - `{ type: "EXTRACT", tabId }` → the content-script extraction object.
  - Port `summarize`: on message `{ baseUrl, apiKey, model, maxTokens, temperature, maxInputChars, page }`, streams the LLM and posts `{ token }`… then `{ done }`; or `{ stopped }` on cancel; or `{ error: { message, detail? } }`. A message `{ cancel: true }` aborts the in-flight request.

- [ ] **Step 1: Write `background.js`**

Replace the stub `background.js` with:
```js
// background.js — MV3 service worker (ES module).
import { extractDataPayloads, tokenFromPayload } from "./lib/sse.js";
import { buildMessages } from "./lib/prompt.js";

const DEFAULT_MAX_INPUT_CHARS = 100000;
let currentTabId = null;

chrome.action.onClicked.addListener((tab) => {
  currentTabId = tab.id;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
    console.error("sidePanel.open failed", err);
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "GET_TAB") {
    const finish = (t) => sendResponse(t ? { tabId: t.id, url: t.url, title: t.title } : { error: "no active tab" });
    if (currentTabId != null) {
      chrome.tabs.get(currentTabId).then(finish).catch((e) => sendResponse({ error: e.message }));
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => finish(t)).catch((e) => sendResponse({ error: e.message }));
    }
    return true; // respond asynchronously
  }

  if (msg.type === "EXTRACT") {
    chrome.tabs
      .sendMessage(msg.tabId, { type: "EXTRACT" })
      .then((res) => sendResponse(res || { ok: false, error: "no response from page" }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // respond asynchronously
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "summarize") return;

  let abortController = null;

  port.onMessage.addListener(async (req) => {
    if (req && req.cancel) {
      if (abortController) abortController.abort();
      return;
    }
    if (!req || !req.baseUrl) {
      port.postMessage({ error: { message: "Missing baseUrl" } });
      return;
    }

    abortController = new AbortController();
    try {
      const messages = buildMessages(req.page, req.maxInputChars || DEFAULT_MAX_INPUT_CHARS);
      const url = `${String(req.baseUrl).replace(/\/+$/, "")}/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${req.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        port.postMessage({ error: { message: `HTTP ${res.status}`, detail: body.slice(0, 500) } });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        const parsed = extractDataPayloads(rest);
        rest = parsed.rest;
        for (const p of parsed.payloads) {
          const { done: isDone, token } = tokenFromPayload(p);
          if (isDone) { port.postMessage({ done: true }); return; }
          if (token) port.postMessage({ token });
        }
      }
      port.postMessage({ done: true });
    } catch (e) {
      if (e && e.name === "AbortError") { port.postMessage({ stopped: true }); return; }
      port.postMessage({ error: { message: (e && e.message) || "Network error" } });
    }
  });

  port.onDisconnect.addListener(() => {
    if (abortController) abortController.abort();
  });
});
```

- [ ] **Step 2: Verify the service worker starts without errors**

1. Load/reload the unpacked extension.
2. On the extension card, click the **"service worker"** link (appears under "Service worker") to open its DevTools.
3. Check the Console: no import errors, no syntax errors. (The worker should be idle until a message arrives.)

Expected: clean console. If there's an import error, the `lib/` path in the imports is wrong (must be `./lib/sse.js` and `./lib/prompt.js`).

- [ ] **Step 3: Run the full test suite (regression)**

Run: `node --test tests/`
Expected: PASS (14 tests; background.js isn't unit-tested here but must not break the suite).

- [ ] **Step 4: Commit**

```bash
git add background.js
git commit -m "feat: background worker (tab/extract relay + streaming LLM)"
```

---

### Task 6: Side panel UI (`sidepanel.html`, `sidepanel.css`, `sidepanel.js`)

**Files:**
- Modify (replace stub): `sidepanel.html`
- Modify (replace stub): `sidepanel.css`
- Create: `sidepanel.js`

**Interfaces:**
- Consumes: background message ops from Task 5 (`GET_TAB`, `EXTRACT`) and the `summarize` port; globals `marked`, `DOMPurify`; `chrome.storage`.
- Produces: the user-facing panel — settings form (pre-filled with defaults, saved to storage), page info, controls (Summarize current page / Re-summarize / Stop), live streaming markdown summary, and error/status messaging.

- [ ] **Step 1: Write `sidepanel.html`**

Replace the stub `sidepanel.html` with:
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="sidepanel.css" />
</head>
<body>
  <header>
    <h1>Page Summarizer</h1>
  </header>

  <section id="page-info" class="hidden">
    <div id="page-title"></div>
    <div id="page-meta"></div>
  </section>

  <section id="controls">
    <button id="btn-summarize">Summarize current page</button>
    <button id="btn-rerun" class="hidden">Re-summarize</button>
    <button id="btn-stop" class="hidden">Stop</button>
  </section>

  <section id="status" class="status"></section>
  <section id="summary" class="markdown"></section>

  <details id="settings">
    <summary>Settings</summary>
    <label>Base URL <input id="set-baseurl" type="text" /></label>
    <label>API key <input id="set-apikey" type="password" /></label>
    <label>Model <input id="set-model" type="text" /></label>
    <label>Max output tokens <input id="set-maxtokens" type="number" min="1" /></label>
    <label>Temperature <input id="set-temperature" type="number" step="0.1" min="0" max="2" /></label>
    <button id="btn-save">Save settings</button>
    <span id="save-note" class="hidden">Saved.</span>
  </details>

  <script src="vendor/marked.min.js"></script>
  <script src="vendor/DOMPurify.min.js"></script>
  <script src="sidepanel.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `sidepanel.css`**

Replace the stub `sidepanel.css` with:
```css
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 12px; }
header h1 { font-size: 15px; margin: 0 0 10px; }
.hidden { display: none !important; }
#page-info { border-left: 3px solid #2563eb; padding: 4px 8px; margin-bottom: 10px; }
#page-title { font-weight: 600; }
#page-meta { font-size: 12px; opacity: .7; word-break: break-all; }
#controls { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
#controls button { padding: 6px 10px; border: 1px solid #8884; background: transparent; border-radius: 6px; cursor: pointer; }
#controls button:hover { background: #2563eb22; }
.status { font-size: 12px; margin: 0 0 8px; min-height: 16px; }
.status.error { color: #d33; }
.markdown { max-width: 100%; overflow-wrap: break-word; }
.markdown h1, .markdown h2, .markdown h3 { font-size: 14px; margin: 12px 0 4px; }
.markdown ul { margin: 4px 0 8px 18px; padding: 0; }
.markdown p { margin: 6px 0; }
details { margin-top: 14px; border-top: 1px solid #8883; padding-top: 8px; }
details summary { cursor: pointer; font-weight: 600; }
details label { display: block; margin: 6px 0; font-size: 13px; }
details input { display: block; width: 100%; margin-top: 2px; padding: 5px; border: 1px solid #8885; border-radius: 5px; }
#btn-save { margin-top: 6px; }
#save-note { font-size: 12px; opacity: .7; margin-left: 8px; }
```

- [ ] **Step 3: Write `sidepanel.js`**

Create `sidepanel.js`:
```js
// sidepanel.js — UI: settings, pipeline trigger, streaming markdown render (classic script).

const DEFAULTS = {
  baseUrl: "http://<redacted-lan-ip>:8090/v1",
  apiKey: "local",
  model: "qwen3.8-27b",
  maxTokens: 2048,
  temperature: 0.3,
  maxInputChars: 100000,
};

let lastPage = null;
let port = null;
let accText = "";

const $ = (id) => document.getElementById(id);
const el = {
  pageInfo: $("page-info"), pageTitle: $("page-title"), pageMeta: $("page-meta"),
  btnSummarize: $("btn-summarize"), btnRerun: $("btn-rerun"), btnStop: $("btn-stop"),
  status: $("status"), summary: $("summary"),
  setBaseUrl: $("set-baseurl"), setApiKey: $("set-apikey"), setModel: $("set-model"),
  setMaxTokens: $("set-maxtokens"), setTemperature: $("set-temperature"),
  btnSave: $("btn-save"), saveNote: $("save-note"),
};

// --- storage (sync with local fallback) ---
async function storageGet(keys) {
  try { return await chrome.storage.sync.get(keys); }
  catch { return await chrome.storage.local.get(keys); }
}
async function storageSet(obj) {
  try { return await chrome.storage.sync.set(obj); }
  catch { return await chrome.storage.local.set(obj); }
}
async function loadSettings() {
  const stored = await storageGet(Object.keys(DEFAULTS));
  return Object.assign({}, DEFAULTS, stored);
}

// --- settings UI ---
function fillSettings(s) {
  el.setBaseUrl.value = s.baseUrl;
  el.setApiKey.value = s.apiKey;
  el.setModel.value = s.model;
  el.setMaxTokens.value = s.maxTokens;
  el.setTemperature.value = s.temperature;
}
async function saveSettings() {
  await storageSet({
    baseUrl: el.setBaseUrl.value.trim(),
    apiKey: el.setApiKey.value.trim(),
    model: el.setModel.value.trim(),
    maxTokens: parseInt(el.setMaxTokens.value, 10) || DEFAULTS.maxTokens,
    temperature: parseFloat(el.setTemperature.value) || 0,
  });
  el.saveNote.classList.remove("hidden");
  setTimeout(() => el.saveNote.classList.add("hidden"), 1500);
}

// --- helpers ---
function setStatus(text, cls) {
  el.status.textContent = text || "";
  el.status.className = "status" + (cls ? " " + cls : "");
}
function showPage(p) {
  el.pageInfo.classList.remove("hidden");
  el.pageTitle.textContent = p.title || "(untitled)";
  el.pageMeta.textContent = [p.siteName, p.url, p.charCount ? p.charCount + " chars" : ""]
    .filter(Boolean).join(" · ");
}
const parseMD = (s) => (typeof marked.parse === "function" ? marked.parse(s) : marked(s));
function renderMarkdown(md) {
  el.summary.innerHTML = DOMPurify.sanitize(parseMD(md || ""));
}

// --- pipeline ---
function startSummarize(page, settings) {
  accText = "";
  el.summary.innerHTML = "";
  el.btnStop.classList.remove("hidden");
  el.btnRerun.classList.add("hidden");
  setStatus("Summarizing…");

  port = chrome.runtime.connect({ name: "summarize" });
  port.onMessage.addListener((msg) => {
    if (msg.token) {
      accText += msg.token;
      renderMarkdown(accText);
    } else if (msg.done) {
      finalize("Done");
    } else if (msg.stopped) {
      finalize("(stopped)");
    } else if (msg.error) {
      setStatus("Error: " + (msg.error.message || "unknown") + (msg.error.detail ? " — " + msg.error.detail : ""), "error");
      finalize();
    }
  });
  port.onDisconnect.addListener(() => finalize());

  port.postMessage({
    baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
    maxTokens: settings.maxTokens, temperature: settings.temperature,
    maxInputChars: settings.maxInputChars, page,
  });
}

function finalize(statusText) {
  if (port) { port.disconnect(); port = null; }
  el.btnStop.classList.add("hidden");
  el.btnRerun.classList.remove("hidden");
  if (statusText && el.status.textContent === "Summarizing…") setStatus(statusText);
}

async function runSummarize(page) {
  const settings = await loadSettings();
  if (!settings.baseUrl || !settings.model) {
    setStatus("Configure your endpoint in Settings first.", "error");
    return;
  }
  lastPage = page;
  startSummarize(page, settings);
}

// --- extraction via background ---
const getTab = () => new Promise((res) => chrome.runtime.sendMessage({ type: "GET_TAB" }, res));
const extractPage = (tabId) => new Promise((res) => chrome.runtime.sendMessage({ type: "EXTRACT", tabId }, res));

async function summarizeCurrentPage() {
  setStatus("Reading page…");
  let tab;
  try { tab = await getTab(); } catch (e) { return setStatus("Could not get current tab.", "error"); }
  if (!tab || tab.tabId == null) return setStatus("No page to summarize.", "error");

  showPage({ title: tab.title, siteName: "", url: tab.url, charCount: 0 });
  let data;
  try { data = await extractPage(tab.tabId); } catch (e) { data = { ok: false, error: e.message }; }

  if (!data || !data.ok) {
    return setStatus(
      data && data.error === "little-text"
        ? "This page has little text to summarize."
        : "Can't summarize this page.",
      "error"
    );
  }
  showPage(data);
  await runSummarize(data);
}

// --- wiring ---
el.btnSummarize.addEventListener("click", summarizeCurrentPage);
el.btnRerun.addEventListener("click", () => { if (lastPage) runSummarize(lastPage); });
el.btnStop.addEventListener("click", () => { if (port) port.postMessage({ cancel: true }); });
el.btnSave.addEventListener("click", saveSettings);

(async function init() {
  fillSettings(await loadSettings());
  // Auto-summarize the page that opened the panel (the icon click).
  await summarizeCurrentPage();
})();
```

- [ ] **Step 4: Manual test — panel loads, settings pre-fill and persist**

1. Load/reload the unpacked extension.
2. Open the side panel (click the toolbar icon on any tab, or via the puzzle menu → Page Summarizer).
3. Expand **Settings**: confirm the three fields are pre-filled with the defaults (`http://<redacted-lan-ip>:8090/v1`, `local`, `qwen3.8-27b`).
4. Change the Model to `qwen-test`, click **Save settings**, confirm the "Saved." note flashes.
5. In the panel's DevTools Console, run: `chrome.storage.local.get(null)` (or `chrome.storage.sync.get(null)`) and confirm `model` is `qwen-test`.

Expected: pre-fill works, save persists, no JS errors in the panel DevTools Console.

- [ ] **Step 5: Commit**

```bash
git add sidepanel.html sidepanel.css sidepanel.js
git commit -m "feat: side panel UI (settings + streaming markdown)"
```

---

### Task 7: End-to-end integration, failure cases, README

**Files:**
- Create: `README.md`
- (No source changes expected — this task verifies and documents. If a bug is found, fix it and add a commit.)

**Interfaces:**
- Consumes: all of Tasks 1–6.

- [ ] **Step 1: Happy path**

1. Load the unpacked extension. Confirm Settings hold your working endpoint (base URL `http://<redacted-lan-ip>:8090/v1`, key `local`, model `qwen3.8-27b`) — the server must be running.
2. Open a content-rich article in a normal tab.
3. Click the toolbar icon.
4. Observe the side panel: page title/url/char count appear, status shows "Summarizing…", and a **Markdown summary streams in** with `**TL;DR**`, a **Key points** bullet list, and a **Takeaway**, including at least one `"double-quoted"` snippet from the article.

Expected: a grounded, structured summary renders and finishes with status "Done".

- [ ] **Step 2: Failure — unsummarizable page**

Open a `chrome://` page (e.g. `chrome://settings`) in a tab, click the icon. Expected: status shows "Can't summarize this page." (no crash).

- [ ] **Step 3: Failure — little-text page**

Open a page with almost no text (e.g. a nearly empty `data:` URL or a page that's just an image), click the icon. Expected: "This page has little text to summarize."

- [ ] **Step 4: Failure — endpoint down**

Stop the local LLM server (or point Settings at a dead port, e.g. `http://<redacted-lan-ip>:9999/v1`, Save, then click the icon on an article). Expected: a network/HTTP error is shown in the status line (not a blank panel, not a JS throw).

- [ ] **Step 5: Stop + Re-summarize**

Start a summarization on a long page. Click **Stop** mid-stream. Expected: the partial summary stays, status shows "(stopped)", and **Re-summarize** becomes visible. Click **Re-summarize** and confirm it regenerates.

- [ ] **Step 6: Long-page robustness**

Open a very long page (e.g. a long documentation page or a news archive). Click the icon. Expected: extraction caps at ~100k chars (check the char count shown in the page-info meta), and the summary still completes.

- [ ] **Step 7: Write `README.md`**

Write `README.md`:
````markdown
# Page Summarizer

A small Chrome extension that summarizes the open page in one click. The
summary streams into Chrome's **side panel** (right) while the page stays on the
left. It uses an OpenAI-compatible chat-completions endpoint (default: a local
`qwen3.8-27b` server) and is grounded in the page's actual text.

## Features
- One toolbar-icon click → grounded, structured summary (TL;DR → Key points → Takeaway) with short quotes.
- Page text extracted with Mozilla Readability (falls back to raw body text).
- Streams tokens live as Markdown.
- Configurable endpoint (base URL / key / model), pre-filled with local defaults.
- Works offline / on a LAN (all libraries bundled locally, no CDN).

## Install (unpacked)
1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.

## Configure the endpoint
Open the side panel → **Settings**. Defaults:
- Base URL: `http://<redacted-lan-ip>:8090/v1`
- API key: `local`
- Model: `qwen3.8-27b`

Edit and **Save settings** if your endpoint differs. The endpoint must be
OpenAI-compatible (`POST {base}/chat/completions`, `Bearer` auth, `stream: true`).

## Use
Click the extension's toolbar icon on the page you want to summarize.

## Development
- `npm test` — runs the pure-logic unit tests (SSE parser, prompt builder) via `node --test`.
- Regenerate icons: `python3 scripts/make_icons.py` (requires Pillow).
- Re-bundle a vendor lib, e.g.: `curl -fsSL <jsdelivr-url> -o vendor/marked.min.js`

## Files
- `manifest.json` — MV3 manifest
- `background.js` — service worker (tab/extract relay + streaming LLM)
- `content.js` — Readability extraction
- `sidepanel.*` — panel UI
- `lib/sse.js`, `lib/prompt.js` — pure, unit-tested modules
- `vendor/` — Readability, marked, DOMPurify
````

- [ ] **Step 8: Run the full test suite (final regression)**

Run: `node --test tests/`
Expected: PASS (14 tests).

- [ ] **Step 9: Commit + tag**

```bash
git add README.md
git commit -m "docs: README with install/usage/dev instructions"
git tag v1.0.0
```

---

## Self-Review (run by the plan author)

**1. Spec coverage**
- §2 endpoint contract → Task 5 (`background.js` fetch, `max_tokens`, Bearer, stream, system/user only). ✔
- §3 file layout + manifest/permissions → Task 1. ✔
- §4 data flow (side panel drives; GET_TAB/EXTRACT/summarize port) → Tasks 5 + 6. ✔
- §5 Readability extraction + fallback + cap → Task 4. ✔
- §6 streaming + SSE parsing + abort → Task 2 (parser) + Task 5 (fetch/abort). ✔
- §7 settings + storage + defaults → Task 6. ✔
- §8 prompt + three-part grounded output → Task 3. ✔
- §9 error handling (all rows) → Tasks 4 (`little-text`), 5 (HTTP/network/abort), 6 (status messages, no-settings). ✔
- §10 rendering (marked + DOMPurify) → Task 6. ✔
- §11 testing (manual + unit for the two pure bits) → Tasks 2, 3 (unit) + Task 7 (manual). ✔

**2. Placeholder scan:** No TBD/TODO; every code step has full code; every test step has runnable command + expected result. Content/background/panel tasks use explicit manual verification steps (load extension, check console/status) rather than vague "add error handling."

**3. Type/name consistency:** `extractDataPayloads`, `tokenFromPayload`, `buildMessages`, `truncateText`, `SYSTEM_PROMPT` — defined in Tasks 2/3 and used identically in Task 5. Message shapes (`GET_TAB`, `EXTRACT`, `summarize` port, `{ token|done|stopped|error }`) consistent between Task 5 (producer) and Task 6 (consumer). Defaults object identical in Task 6 `DEFAULTS` and the Global Constraints.
