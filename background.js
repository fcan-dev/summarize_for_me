// background.js — MV3 service worker (ES module).
import { extractDataPayloads, tokenFromPayload } from "./lib/sse.js";
import { buildMessages } from "./lib/prompt.js";

const DEFAULT_MAX_INPUT_CHARS = 100000;

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
          const { done: isDone, token, reasoning } = tokenFromPayload(p);
          if (isDone) { port.postMessage({ done: true }); return; }
          if (token) port.postMessage({ token });
          if (reasoning) port.postMessage({ reasoning });
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
