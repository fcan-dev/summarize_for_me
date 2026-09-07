# Page Summarizer

A small Chrome extension that summarizes the open page in one click. The
summary streams into Chrome's **side panel** (right) while the page stays on the
left. It uses an OpenAI-compatible chat-completions endpoint (default: a local
`qwen3.8-27b` server) and is grounded in the page's actual text.

## Features
- One toolbar-icon click → grounded, structured summary (TL;DR → Key points → Takeaway) with short quotes.
- Summaries are written in the **same language as the article**. You click **Summarize current page** to run — it does not auto-run on panel open.
- Page text extracted with Mozilla Readability (falls back to raw body text).
- Streams tokens live as Markdown (including a live “Thinking…” indicator for reasoning models).
- **Local history:** every finished summary is stored in Chrome local storage keyed by page URL, so revisiting a page shows its saved summary instantly even after a browser restart.
- **Tab-aware panel:** switching tabs updates the panel to that page's context — its cached summary if one exists, otherwise the “summarize this page” state.
- Configurable endpoint (base URL / key / model / summary length), pre-filled with local defaults.
- Works offline / on a LAN (all libraries bundled locally, no CDN).

## Install (unpacked)
1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.

## Configure the endpoint
Open the side panel → **Settings**. Defaults:
- Base URL: `http://<redacted-ip>:8090/v1`
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
