// sidepanel.js — UI: settings, pipeline trigger, streaming markdown render (classic script).

const DEFAULTS = {
  baseUrl: "http://<redacted-ip>:8090/v1",
  apiKey: "local",
  model: "qwen3.8-27b",
  maxLength: "medium",
  maxInputChars: 100000,
};

// Categorical summary length -> max output tokens sent to the model.
const MAX_LENGTH_TOKENS = { short: 512, medium: 1024, long: 2048 };

let currentUrl = null; // URL of the page the panel is currently showing
let currentStream = null; // the in-flight/background summary stream, if any

// Summary history. Stored in chrome.storage.local keyed by page URL so it
// survives browser restarts. Each value: { url, title, siteName, charCount,
// summary, createdAt }.
const SUMMARY_DB_KEY = "summaries";

async function getAllSummaries() {
  try { return (await chrome.storage.local.get(SUMMARY_DB_KEY))[SUMMARY_DB_KEY] || {}; }
  catch { return {}; }
}

async function getSummary(url) {
  if (!url) return null;
  const all = await getAllSummaries();
  return all[url] || null;
}

async function saveSummary(url, record) {
  if (!url) return;
  const all = await getAllSummaries();
  all[url] = record;
  try { await chrome.storage.local.set({ [SUMMARY_DB_KEY]: all }); }
  catch (e) { console.error("saveSummary failed", e); }
}

async function deleteSummary(url) {
  if (!url) return;
  const all = await getAllSummaries();
  delete all[url];
  try { await chrome.storage.local.set({ [SUMMARY_DB_KEY]: all }); }
  catch (e) { console.error("deleteSummary failed", e); }
}

const $ = (id) => document.getElementById(id);
const el = {
  pageInfo: $("page-info"), pageTitle: $("page-title"), pageMeta: $("page-meta"),
  btnSummarize: $("btn-summarize"), btnRerun: $("btn-rerun"), btnStop: $("btn-stop"),
  status: $("status"), summary: $("summary"),
  setBaseUrl: $("set-baseurl"), setApiKey: $("set-apikey"), setModel: $("set-model"),
  setMaxLength: $("set-maxlength"),
  btnSave: $("btn-save"), saveNote: $("save-note"),
  history: $("history"), historyList: $("history-list"),
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
  el.setMaxLength.value = s.maxLength || DEFAULTS.maxLength;
}
async function saveSettings() {
  await storageSet({
    baseUrl: el.setBaseUrl.value.trim(),
    apiKey: el.setApiKey.value.trim(),
    model: el.setModel.value.trim(),
    maxLength: el.setMaxLength.value || DEFAULTS.maxLength,
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
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --- pipeline ---
// Fully cancel the in-flight stream and close its port (background aborts the
// fetch via onDisconnect). Used by the Stop button and when starting a new
// summary — NOT on tab switch, which only backgrounds the stream.
function stopStream() {
  const s = currentStream;
  if (s && s.port) {
    currentStream = null;
    s.port.disconnect();
  }
}

// Keep the current stream running in the background: mark it backgrounded so
// it stops painting to the panel, but leave the port open so the fetch
// continues. Its result is still saved to the local DB on completion.
function backgroundCurrentStream() {
  if (currentStream) currentStream.backgrounded = true;
}

function startSummarize(page, settings) {
  stopStream(); // cancel any prior stream so there's never two at once

  // Bind this stream to its own page metadata + port so a tab switch (which
  // changes currentUrl / the visible context) can't misattribute the saved
  // summary, and a stale stream's disconnect can't kill a newer one.
  const stream = {
    url: (page && page.url) || currentUrl,
    title: (page && page.title) || "",
    siteName: (page && page.siteName) || "",
    charCount: (page && page.charCount) || 0,
    buffer: "",
    backgrounded: false,
    port: null,
  };
  currentStream = stream;
  const isForeground = () => currentStream === stream && !stream.backgrounded;

  el.summary.innerHTML = "";
  el.btnStop.classList.remove("hidden");
  el.btnRerun.classList.add("hidden");
  setStatus("Summarizing…");

  const p = chrome.runtime.connect({ name: "summarize" });
  stream.port = p;

  p.onMessage.addListener((msg) => {
    // Reasoning models (e.g. Qwen3) "think" first via delta.reasoning_content.
    if (msg.reasoning) {
      stream.reasoning = (stream.reasoning || 0) + msg.reasoning.length;
      if (isForeground() && el.summary.childElementCount === 0) setStatus(`Thinking… (${stream.reasoning})`);
    } else if (msg.token) {
      stream.buffer += msg.token;
      if (isForeground()) {
        if (el.summary.childElementCount === 0) setStatus("Summarizing…");
        renderMarkdown(stream.buffer);
      }
    } else if (msg.done) {
      // Persist the finished summary keyed by THIS stream's URL (local db),
      // even if the stream ran in the background while another tab was shown.
      if (stream.url && stream.buffer.trim()) {
        saveSummary(stream.url, {
          url: stream.url,
          title: stream.title,
          siteName: stream.siteName,
          charCount: stream.charCount,
          summary: stream.buffer,
          createdAt: Date.now(),
        });
        renderHistory();
      }
      finishStream(stream, "Done");
    } else if (msg.stopped) {
      finishStream(stream, "(stopped)");
    } else if (msg.error) {
      if (isForeground()) {
        setStatus("Error: " + (msg.error.message || "unknown") + (msg.error.detail ? " — " + msg.error.detail : ""), "error");
      }
      finishStream(stream);
    }
  });
  p.onDisconnect.addListener(() => finishStream(stream));

  p.postMessage({
    baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
    maxTokens: MAX_LENGTH_TOKENS[settings.maxLength] || MAX_LENGTH_TOKENS.medium,
    maxInputChars: settings.maxInputChars, page,
  });
}

// Clean up a stream. No-ops if it's no longer the current stream (e.g. it was
// replaced or cancelled). Only touches the panel UI if it was foreground.
function finishStream(stream, statusText) {
  if (currentStream !== stream) return;
  const wasForeground = !stream.backgrounded;
  if (stream.port) { try { stream.port.disconnect(); } catch {} stream.port = null; }
  currentStream = null;
  if (wasForeground) {
    el.btnStop.classList.add("hidden");
    el.btnRerun.classList.remove("hidden");
    if (statusText && el.status.textContent === "Summarizing…") setStatus(statusText);
  }
}

async function runSummarize(page) {
  const settings = await loadSettings();
  if (!settings.baseUrl || !settings.model) {
    setStatus("Configure your endpoint in Settings first.", "error");
    return;
  }
  currentUrl = (page && page.url) || currentUrl;
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
  currentUrl = tab.url || null;
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

// Show the active tab's context in the panel: a cached summary if one
// exists, otherwise a neutral "summarize this page" state. Does NOT call the
// LLM — used on panel open and on tab switch.
async function refreshForCurrentTab() {
  let tab;
  try { tab = await getTab(); } catch (e) { return setStatus("Could not get current tab.", "error"); }
  if (!tab || tab.tabId == null) return setStatus("No page to summarize.", "error");

  currentUrl = tab.url || null;
  el.pageInfo.classList.remove("hidden");
  el.pageTitle.textContent = tab.title || "(untitled)";
  el.pageMeta.textContent = [tab.url || ""].filter(Boolean).join(" · ");

  // Keep any in-flight summary running in the background (do NOT cancel it)
  // so it finishes and saves even after switching tabs; the panel now shows
  // the newly active tab's context instead.
  backgroundCurrentStream();
  el.btnStop.classList.add("hidden");

  const cached = await getSummary(currentUrl);
  if (cached && cached.summary) {
    el.summary.innerHTML = DOMPurify.sanitize(parseMD(cached.summary));
    setStatus("Loaded from history");
    el.btnRerun.classList.remove("hidden");
  } else {
    el.summary.innerHTML = "";
    setStatus("");
    el.btnRerun.classList.add("hidden");
  }
}

// --- history view ---
// Render the list of all stored summaries, newest first.
async function renderHistory() {
  const all = await getAllSummaries();
  const entries = Object.values(all)
    .filter((e) => e && e.summary)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (entries.length === 0) {
    el.historyList.innerHTML = '<li class="h-title" id="history-empty">No summaries yet.</li>';
    return;
  }
  el.historyList.innerHTML = entries.map((e) => {
    const title = escapeHtml(e.title || "(untitled)");
    const meta = e.siteName || "";
    const ts = e.createdAt ? new Date(e.createdAt).toLocaleDateString() : "";
    return (
      `<li><span class="h-title" title="${escapeHtml(e.url || "")}">${title}</span>` +
      `<span class="h-meta">${escapeHtml(meta)}${meta ? " · " : ""}${escapeHtml(ts)}</span>` +
      `<button data-view="${encodeURIComponent(e.url)}">View</button>` +
      `<button data-del="${encodeURIComponent(e.url)}">✕</button></li>`
    );
  }).join("");
}

// Show a stored summary (from the history list) in the main view without
// switching the Chrome tab.
function viewHistoryItem(url) {
  getSummary(url).then((cached) => {
    if (!cached) return;
    currentUrl = url;
    el.pageInfo.classList.remove("hidden");
    el.pageTitle.textContent = cached.title || "(untitled)";
    el.pageMeta.textContent = [cached.siteName, url, cached.charCount ? cached.charCount + " chars" : ""]
      .filter(Boolean).join(" · ");
    backgroundCurrentStream(); // don't cancel a running summary; keep it in bg
    el.summary.innerHTML = DOMPurify.sanitize(parseMD(cached.summary));
    setStatus("From history");
    el.btnStop.classList.add("hidden");
    el.btnRerun.classList.remove("hidden");
  });
}

// --- wiring ---
el.btnSummarize.addEventListener("click", summarizeCurrentPage);
el.btnRerun.addEventListener("click", summarizeCurrentPage);
el.btnStop.addEventListener("click", () => {
  // Cancel the in-flight stream (the background aborts the fetch).
  if (currentStream && currentStream.port) currentStream.port.postMessage({ cancel: true });
  stopStream();
});
el.btnSave.addEventListener("click", saveSettings);

// Populate history when it is opened (and refresh on click within it).
el.history.addEventListener("toggle", () => { if (el.history.open) renderHistory(); });
el.historyList.addEventListener("click", async (ev) => {
  const viewBtn = ev.target.closest("button[data-view]");
  const delBtn = ev.target.closest("button[data-del]");
  if (viewBtn) {
    viewHistoryItem(decodeURIComponent(viewBtn.dataset.view));
  } else if (delBtn) {
    const url = decodeURIComponent(delBtn.dataset.del);
    await deleteSummary(url);
    await renderHistory();
  }
});

// React to tab switches so the panel always reflects the active page's
// context (cached summary if one exists, else the default state).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "TAB_ACTIVATED") {
    refreshForCurrentTab();
  }
});

(async function init() {
  fillSettings(await loadSettings());
  // Show the current tab's context (cached summary or the default state).
  await refreshForCurrentTab();
})();
