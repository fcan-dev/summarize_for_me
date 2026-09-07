// background.js — MV3 service worker (ES module).
import { extractDataPayloads, tokenFromPayload } from "./lib/sse.js";
import { buildMessages } from "./lib/prompt.js";

const DEFAULT_MAX_INPUT_CHARS = 100000;

// --- Serial summarization queue (worker-owned) ---
// Jobs run one at a time; starting a summary just enqueues it. Each job
// streams via fetch and broadcasts its progress events to the side panel,
// decoupled from any single port so work continues even when the panel is
// showing a different tab or is closed. Results are persisted by the panel on
// SUMMARY_DONE (attributed by the job's page URL).
const queue = [];
let processing = false;
let jobCounter = 0;

function broadcast(msg) {
  // Notify the side panel(s); safe if none are listening.
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastQueueStatus() {
  // processing === 1 running job; queue holds only the waiting ones.
  broadcast({ type: "QUEUE_CHANGED", running: processing ? 1 : 0, waiting: queue.length });
}

function enqueue(page, settings) {
  const job = {
    id: ++jobCounter,
    page,
    settings,
    controller: null,
  };
  queue.push(job);
  broadcastQueueStatus();
  processNext();
  return job;
}

// Cancel the running job and drop queued jobs that target the same URL.
function cancelByUrl(url) {
  if (!url) return;
  const running = queue[0];
  if (running && running.page && running.page.url === url) {
    if (running.controller) running.controller.abort();
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].page && queue[i].page.url === url) queue.splice(i, 1);
  }
  broadcastQueueStatus();
}

async function processNext() {
  if (processing) return;
  const job = queue.shift();
  if (!job) return;
  processing = true;
  broadcastQueueStatus(); // a job is now running
  try {
    await runJob(job);
  } finally {
    processing = false;
    broadcastQueueStatus(); // the running job finished
    processNext(); // continue the queue
  }
}

async function runJob(job) {
  const { page, settings } = job;
  broadcast({ type: "SUMMARY_STARTED", id: job.id, page: pageInfo(page) });
  job.controller = new AbortController();

  try {
    const messages = buildMessages(page, settings.maxInputChars || DEFAULT_MAX_INPUT_CHARS);
    const url = `${String(settings.baseUrl).replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        max_tokens: settings.maxTokens,
        stream: true,
      }),
      signal: job.controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      broadcast({ type: "SUMMARY_ERROR", id: job.id, message: `HTTP ${res.status}`, detail: body.slice(0, 500) });
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
        const { done: isDone, token, reasoning } = tokenFromPayload(p);
        if (isDone) { broadcast({ type: "SUMMARY_DONE", id: job.id, page: pageInfo(page) }); return; }
        if (token) broadcast({ type: "SUMMARY_TOKEN", id: job.id, page: pageInfo(page), token });
        if (reasoning) broadcast({ type: "SUMMARY_REASONING", id: job.id, page: pageInfo(page), reasoning });
      }
    }
    broadcast({ type: "SUMMARY_DONE", id: job.id, page: pageInfo(page) });
  } catch (e) {
    if (e && e.name === "AbortError") { broadcast({ type: "SUMMARY_STOPPED", id: job.id, page: pageInfo(page) }); return; }
    broadcast({ type: "SUMMARY_ERROR", id: job.id, message: (e && e.message) || "Network error" });
  }
}

function pageInfo(page) {
  return {
    url: (page && page.url) || "",
    title: (page && page.title) || "",
    siteName: (page && page.siteName) || "",
    charCount: (page && page.charCount) || 0,
  };
}

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
    console.error("sidePanel.open failed", err);
  });
});

// Notify the side panel whenever the user switches tabs OR navigates to a
// new page in the same tab so it can show the newly active page's context
// (cached summary if one exists, else the "summarize this page" state).
chrome.tabs.onActivated.addListener((info) => {
  chrome.runtime.sendMessage({ type: "TAB_ACTIVATED", tabId: info.tabId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A loaded navigation. Use the authoritative Tab object (3rd arg) so we
  // get the current URL even though the URL-bearing event and the
  // "complete" event are usually separate in changeInfo. Only refresh when
  // the navigating tab is the one currently in front of the user.
  if (changeInfo.status === "complete" && tab && tab.active && tab.url) {
    chrome.runtime.sendMessage({ type: "TAB_ACTIVATED", tabId }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "GET_TAB") {
    // The panel follows the actively focused tab.
    const finish = (t) => sendResponse(t ? { tabId: t.id, url: t.url, title: t.title } : { error: "no active tab" });
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => finish(t)).catch((e) => sendResponse({ error: e.message }));
    return true; // respond asynchronously
  }

  if (msg.type === "EXTRACT") {
    chrome.tabs
      .sendMessage(msg.tabId, { type: "EXTRACT" })
      .then((res) => sendResponse(res || { ok: false, error: "no response from page" }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // respond asynchronously
  }

  if (msg.type === "ENQUEUE") {
    // Queue a summary job. Settings/baseUrl are required to run it.
    if (!msg.settings || !msg.settings.baseUrl || !msg.page) {
      sendResponse({ error: "missing page or settings" });
      return true;
    }
    const job = enqueue(msg.page, msg.settings);
    sendResponse({ id: job.id });
    return true;
  }

  if (msg.type === "ENQUEUE_CANCEL") {
    // Cancel the running job for this URL and drop any queued ones for it.
    cancelByUrl(msg.url);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
