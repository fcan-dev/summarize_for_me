# Page Summarizer (Chrome Extension) — Design

**Date:** 2026-09-04
**Status:** Approved design, pending spec review
**Type:** New project (Manifest V3 Chrome extension)

## 1. Overview

A small Chrome extension that summarizes the currently open page in **one click**.
The result appears in Chrome's **side panel** (docked to the right), while the
original page stays on the left — the "split" view. The summary is produced by an
**OpenAI-compatible chat-completions endpoint** (the user runs a local
`qwen3.8-27b` server, but any OpenAI-v1-style endpoint works). The summary is
**grounded in the source text** (short verbatim quotes), **structured**, and
**streamed** token-by-token into the panel.

### Goals
- One click (toolbar icon) → summary streams into the side panel.
- Use the page's **actual content** (Readability extraction), not just the URL.
- Grounded, structured output: TL;DR → Key points (bullets) → Takeaway.
- Length adapts to the content.
- Configurable OpenAI-v1 endpoint (base URL / key / model), pre-filled with the
  user's local defaults so it works out of the box.
- Works offline / on LAN (all dependencies bundled locally, no CDN).

### Non-goals (YAGNI)
- No multi-page / tab batch summarization.
- No summary history / library / export (a possible future feature).
- No authentication/encryption of the stored API key (it is a local dummy key).
- No i18n, no theming beyond a clean default.
- No image/multimodal input (the endpoint supports images, but v1 is text-only).

## 2. Target endpoint (integration contract)

OpenAI-compatible **chat completions** endpoint:

- `POST {baseUrl}/chat/completions`
- Header: `Authorization: Bearer {apiKey}`
- Body:
  ```json
  {
    "model": "qwen3.8-27b",
    "messages": [
      { "role": "system", "content": "..." },
      { "role": "user",   "content": "..." }
    ],
    "max_tokens": 2048,
    "temperature": 0.3,
    "stream": true
  }
  ```
- Stream response: standard SSE, `data: {…}` lines; each chunk carries
  `choices[0].delta.content`; stream ends with `data: [DONE]`.

Endpoint compat constraints (from the user's provider config) that we respect:
- `supportsDeveloperRole: false` → **only** `system`/`user`/`assistant` roles.
- `maxTokensField: max_tokens` → use `max_tokens` (not `max_completion_tokens`).
- `supportsReasoningEffort: false` → do **not** send reasoning-effort fields.
- Model has a large context window (262144 tokens) → we can send long page text,
  but we still cap input text for cost/speed/robustness (see §6).

Default settings (pre-filled, editable):
- Base URL: `http://<redacted-lan-ip>:8090/v1`
- API key: `local`
- Model: `qwen3.8-27b`

## 3. Architecture & file layout (Manifest V3)

```
chrome_extension_summarize/
├── manifest.json
├── background.js          # service worker: icon click, extraction relay, streaming fetch
├── content.js             # content script: Readability page-text extraction
├── sidepanel.html         # the "right" panel (page stays on the left)
├── sidepanel.js           # settings form, pipeline trigger, streaming render, markdown
├── sidepanel.css          # panel styling
├── vendor/                # bundled locally (no CDN → works offline / on LAN)
│   ├── Readability.js     # Mozilla Readability
│   ├── marked.min.js      # markdown → html
│   └── DOMPurify.min.js   # sanitize rendered html
└── icons/                 # 16 / 32 / 48 / 128 px
```

### manifest.json (key fields)
```json
{
  "manifest_version": 3,
  "name": "Page Summarizer",
  "version": "1.0.0",
  "description": "One-click grounded page summaries in the side panel.",
  "permissions": ["storage", "sidePanel", "activeTab"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "Summarize page", "default_icon": { "16":"icons/16.png","32":"icons/32.png","48":"icons/48.png","128":"icons/128.png" } },
  "icons": { "16":"icons/16.png","32":"icons/32.png","48":"icons/48.png","128":"icons/128.png" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["vendor/Readability.js", "content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

**Permission rationale**
- `storage` — persist settings.
- `sidePanel` — open the side panel (the split view).
- `activeTab` — read the clicked page (minimal; granted by the icon click gesture).
- `host_permissions: <all_urls>` — lets the **background service worker** reach any
  endpoint (local LAN IP or cloud) without CORS blocking. This is the deliberate
  broad permission that makes user-configurable endpoints work; it is the main
  trade-off of this design.

## 4. Data flow (one click → summary)

The **side panel is the driver** after it opens (avoids pushing messages to a
panel that isn't loaded yet). Background exposes small, isolated operations.

1. User clicks the **toolbar icon** → `background.js` `chrome.action.onClicked`:
   - opens the **side panel** for that window (`chrome.sidePanel.open({ windowId })`),
   - records the active tab (id, url, title) as the "current request".
2. **Side panel** loads (`sidepanel.html`):
   - asks background `{ type: "GET_TAB" }` → gets `{ tabId, url, title }`.
   - asks background `{ type: "EXTRACT", tabId }`.
3. **Background** relays `EXTRACT` to the **content script** in that tab
   (`chrome.tabs.sendMessage(tabId, { type: "EXTRACT" })`) and returns the result.
4. **Content script** extracts text (see §5) → returns
   `{ ok, title, siteName, byline, text, charCount, error? }`.
5. **Side panel** loads saved **settings** from `chrome.storage`, builds the
   prompt, and opens a **streaming port** `chrome.runtime.connect({ name: "summarize" })`
   sending `{ baseUrl, apiKey, model, maxTokens, temperature, messages }`.
6. **Background** performs the streaming `fetch`, parses SSE chunks, and posts
   `{ token }` per chunk, then `{ done }`, or `{ error }` on failure.
7. **Side panel** renders tokens live as Markdown (marked + DOMPurify).

### Background message operations
- `GET_TAB` → `{ tabId, url, title }` (the tab the icon was clicked on, else the
  active tab in the current window).
- `EXTRACT { tabId }` → relays to content script, returns the extraction result.
- Port `summarize` → streaming LLM call (see §6 for SSE handling).

If the user opens the side panel **manually** (not via the icon), it shows a hint
plus a **"Summarize current page"** button that runs the same pipeline (robust
fallback). A **"Re-summarize"** button re-runs the last pipeline (retry/regenerate).

## 5. Content script: page-text extraction (Readability)

`content.js` (runs on all `http/https` pages; `Readability` is loaded into the
same context via the manifest `content_scripts`):

- On `{ type: "EXTRACT" }`:
  1. Clone the document so Readability's DOM mutations don't affect the live page:
     `const clone = document.cloneNode(true);`
  2. `const article = new Readability(clone, { charThreshold: 200 }).parse();`
  3. If `article && article.textContent.trim().length >= 200` → use it.
     Otherwise **fall back** to `document.body.innerText` (raw) — the hybrid so
     odd/SPA pages still yield something.
  4. Cap the returned text at `MAX_INPUT_CHARS` (default **100,000** chars,
     configurable) to fit the model and keep cost/speed sane.
  5. Return `{ ok: true, title, siteName, byline, text, charCount }`.
- If the page is a browser-internal URL or the DOM is empty, return
  `{ ok: false, error: "…" }`.
- No UI, no network in the content script — extraction only.

**Truncation policy:** cap at 100k chars by default (≈ 25k tokens), leaving ample
room within the 262k context window for output. Capping is a hard cut at the end
of the extracted text; the prompt notes the text may be truncated.

## 6. Background: streaming LLM call & SSE parsing

`background.js` streaming handler (module-scoped, no DOM):

- `fetch(baseUrl + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ …, stream: true }) })`.
- Read `response.body` as a stream, split on newlines, handle SSE:
  - ignore lines not starting with `data:`;
  - `data: [DONE]` → end;
  - else `JSON.parse` the payload, read `choices[0]?.delta?.content ?? ""`, forward
    each non-empty token via `port.postMessage({ token })`.
- On success: `port.postMessage({ done: true })`.
- On network/CORS error or non-200: `port.postMessage({ error: { message, status? } })`.
- **Abort:** a page-level `AbortController`; the side panel can cancel a running
  stream (a "Stop" control) and closing the panel should abort it.

The SSE line/buffer parser is a **pure function** (`parseSSE(buffer) → { tokens, rest }`)
so it can be unit-tested in Node without a browser.

## 7. Settings & storage

- Stored in `chrome.storage.sync` (falls back to `local` if sync unavailable).
- Fields: `baseUrl`, `apiKey`, `model`, `maxTokens` (default 2048),
  `temperature` (default 0.3), `maxInputChars` (default 100000).
- Pre-filled defaults: `baseUrl = http://<redacted-lan-ip>:8090/v1`, `apiKey = local`,
  `model = qwen3.8-27b`.
- UI: a collapsible **Settings** section in the side panel; a **Save** button
  persists; the pipeline always reads the latest saved values.

## 8. Prompt & output format

- **Roles:** `system` + `user` only (no `developer`).
- **System prompt** (summary of intent):
  > You are a precise summarization assistant. Summarize only the article text
  > provided. Ground your summary in the source: include a few short verbatim
  > quotes (in "double quotes") that support the key points. Respond in Markdown
  > with exactly: a 1–2 sentence **TL;DR**, then **Key points** as a bulleted
  > list, then a one-line **Takeaway**. Match the depth to the length and
  > substance of the content — keep it short for short/thin pages, be more
  > detailed for long/rich ones. If the source is thin, keep it brief and say so.
  > Output only the summary.
- **User message:** a short header (`Title`, `Site`, `URL`) followed by the
  extracted `text`.

## 9. Error handling

| Situation | Behavior |
|-----------|----------|
| Unsummarizable page (chrome://, store, extension, empty DOM) | Friendly "Can't summarize this page." |
| Too little extractable text | "This page has little text to summarize." |
| No settings saved / empty baseUrl | Prompt to configure the endpoint. |
| Endpoint unreachable / network error | Show error + hint ("Is the server running? Is the URL correct?"). |
| Non-200 from API | Show status + server message. |
| CORS / blocked | Show "Request blocked — check host permissions / server CORS." |
| Mid-stream failure | Show partial summary + error note. |
| User stops | Show partial summary + "(stopped)". |
| **Re-summarize** | Retry/regenerate the last pipeline. |

## 10. Rendering

- Stream tokens into a content element; render **Markdown → HTML** with `marked`,
  sanitized with **DOMPurify** before insertion (page text + model output are
  untrusted).
- Lightweight styling: TL;DR, bullet list, takeaway, inline quotes; a subtle
  "streaming" cursor while in progress.

## 11. Testing

- **Manual (primary):** load the unpacked extension at
  `chrome://extensions` → open a real article → click the icon → verify a
  grounded, structured summary streams in. Then verify the failure cases:
  a chrome:// page, an empty page, a very long page, and a stopped server.
- **Unit (pure logic, Node):** the **SSE chunk parser** and the **prompt builder**
  (message assembly + truncation). These are the only two bits of non-trivial
  logic worth automated tests.
- **Install/run instructions** go in a top-level `README.md`
  (load unpacked → configure endpoint → click icon).

## 12. Future (explicitly out of scope for v1)
- Summary history/library, export (md/txt/copy), share.
- Per-site custom prompts; choose output language.
- "Developer" role / reasoning-effort controls if the endpoint gains support.
- Image input (endpoint supports images) for screenshots/charts.
