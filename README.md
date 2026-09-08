# Page Summarizer

A small Chrome extension that summarizes the open page in one click. The
summary streams into Chrome's **side panel** (right) while the page stays on the
left. It works with any OpenAI-compatible chat-completions endpoint (local or hosted)
and is grounded in the page's actual text.

## Features
- One toolbar-icon click → grounded, structured summary (TL;DR → Key points → Takeaway) with short quotes.
- Summaries are written in the **same language as the article**. You click **Summarize current page** to run — it does not auto-run on panel open.
- Page text extracted with Mozilla Readability (falls back to raw body text).
- Streams tokens live as Markdown (including a live “Thinking…” indicator for reasoning models).
- **Local history:** every finished summary is stored in Chrome local storage keyed by page URL, so revisiting a page shows its saved summary instantly even after a browser restart.
- **Tab-aware panel:** switching tabs updates the panel to that page's context — its cached summary if one exists, otherwise the “summarize this page” state.
- **Background queue:** each summary is a job in a worker-owned FIFO queue, processed one at a time. Starting another summary (on another page or tab) just enqueues it — nothing is cancelled. Jobs you're not currently viewing stream and save in the background, and a queue indicator shows how many are waiting. Every finished summary is always stored.
- Configurable endpoint (base URL / key / model / summary length), pre-filled with local defaults.
- Works offline / on a LAN (all libraries bundled locally, no CDN).

## Install (unpacked)
1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.

## Configure the endpoint
Open the side panel → **Settings**. Set:
- Base URL: your OpenAI-compatible server, e.g. `http://localhost:8000/v1`
- API key: whatever your server expects (many local servers accept anything)
- Model: the model name your server serves

Then **Save settings**. The endpoint must be
OpenAI-compatible (`POST {base}/chat/completions`, `Bearer` auth, `stream: true`)
— e.g. [vLLM](https://github.com/vllm-project/vllm), [llama.cpp](https://github.com/ggml-org/llama.cpp), [Ollama](https://github.com/ollama/ollama), LM Studio, or any hosted API.

## Use
Click the extension's toolbar icon on the page you want to summarize.

## Permissions & privacy
- `storage` — saves your settings and summary history in Chrome local storage.
- `sidePanel` — opens the summary panel.
- `tabs` — knows which page is open.
- `host_permissions: <all_urls>` — needed to send page text to **your own** configurable endpoint. The extension has no other network access: it only ever calls the base URL you configure in Settings, and never sends anything else. History and settings never leave your browser.

## Development
- `npm test` — runs the pure-logic unit tests (SSE parser, prompt builder) via `node --test`.
- Regenerate icons: `python3 scripts/make_icons.py` (requires Pillow).
- Re-bundle a vendor lib, e.g.: `curl -fsSL <jsdelivr-url> -o vendor/marked.min.js`
  (keep attribution up to date in [THIRD_PARTY.md](THIRD_PARTY.md))

CI (GitHub Actions) runs the test suite on every push and pull request.

## Files
- `manifest.json` — MV3 manifest
- `background.js` — service worker (tab/extract relay + streaming LLM)
- `content.js` — Readability extraction
- `sidepanel.*` — panel UI
- `lib/sse.js`, `lib/prompt.js` — pure, unit-tested modules
- `vendor/` — Readability, marked, DOMPurify (see [THIRD_PARTY.md](THIRD_PARTY.md))
- `tests/` — unit tests for the pure modules (`node --test`)

## License
MIT — see [LICENSE](LICENSE). Vendored libraries in `vendor/` are distributed
under their own licenses (Apache-2.0 / MPL-2.0 / MIT); see
[THIRD_PARTY.md](THIRD_PARTY.md).
