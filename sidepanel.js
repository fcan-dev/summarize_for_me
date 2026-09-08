// sidepanel.js — UI: settings, pipeline trigger, streaming markdown render (classic script).

const DEFAULTS = {
  // Point these at any OpenAI-compatible server (vLLM, llama.cpp, Ollama, ...).
  // Adjust in Settings once your endpoint is running.
  baseUrl: "http://localhost:8000/v1",
  apiKey: "local",
  model: "your-model",
  maxLength: "medium",
  maxInputChars: 100000,
};

// Categorical summary length -> max output tokens sent to the model.
const MAX_LENGTH_TOKENS = { short: 512, medium: 1024, long: 2048 };

let currentUrl = null; // URL of the page the panel is currently showing

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
  pageFavicon: $("page-favicon"),
  btnSummarize: $("btn-summarize"), btnRerun: $("btn-rerun"), btnStop: $("btn-stop"),
  status: $("status"), summary: $("summary"), queueInfo: $("queue-info"),
  emptyState: $("empty-state"),
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
  setFavicon(p.url);
}

// First letter of the page's hostname, shown as a monogram chip.
function setFavicon(url) {
  let initial = "?";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host) initial = host[0].toUpperCase();
  } catch { /* non-http url or empty */ }
  el.pageFavicon.textContent = initial;
}

// Show the empty-state placeholder only when the summary area is empty
// and no job is being painted in the panel.
function syncEmptyState() {
  const hasContent = el.summary.childElementCount > 0;
  const streaming = renderJobId !== null;
  el.emptyState.classList.toggle("hidden", hasContent || streaming);
}
const parseMD = (s) => (typeof marked.parse === "function" ? marked.parse(s) : marked(s));
function renderMarkdown(md) {
  el.summary.innerHTML = DOMPurify.sanitize(parseMD(md || ""));
  syncEmptyState();
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --- pipeline (background queue events) ---
// The worker owns a FIFO queue and broadcasts SUMMARY_* / QUEUE_CHANGED
// events. The panel renders at most one job (renderJob) — the one started
// for the currently shown page; everything else streams & saves in the bg.
// Buffers for ALL in-flight/background jobs so every summary is saved, even
// when the panel only paints the foreground job for the currently shown page.
const jobs = new Map(); // id -> { page, buffer, reasoning }
let renderJobId = null; // id of the job being painted in the panel, if any
let queueRunning = 0;
let queueWaiting = 0;

const isForeground = (id) => renderJobId === id;

function updateQueueInfo() {
  const total = queueRunning + queueWaiting;
  if (total === 0) {
    el.queueInfo.classList.add("hidden");
    el.queueInfo.textContent = "";
    return;
  }
  el.queueInfo.classList.remove("hidden");
  el.queueInfo.textContent =
    (queueRunning ? "Summarizing…" : "Queued…") +
    (queueWaiting ? ` · ${queueWaiting} waiting` : "");
}

function jobFor(id, page) {
  let j = jobs.get(id);
  if (!j) {
    j = {
      page: page || { url: "", title: "", siteName: "", charCount: 0 },
      buffer: "",
      reasoning: 0,
    };
    jobs.set(id, j);
  }
  return j;
}

async function runSummarize(page) {
  const settings = await loadSettings();
  if (!settings.baseUrl || !settings.model) {
    setStatus("Configure your endpoint in Settings first.", "error");
    return;
  }
  currentUrl = (page && page.url) || currentUrl;

  el.summary.innerHTML = "";
  el.emptyState.classList.add("hidden");
  el.btnStop.classList.remove("hidden");
  el.btnRerun.classList.add("hidden");
  setStatus("Queuing…", "live");

  const res = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "ENQUEUE", page, settings }, resolve)
  );
  if (res && res.id != null) {
    jobFor(res.id, page); // start buffering this job
    renderJobId = res.id; // and paint it (it's the current view's summary)
  }
  setStatus("Summarizing…", "live");
}

// Handle a summary-progress event broadcast by the background worker.
function handleSummaryEvent(msg) {
  if (!msg || typeof msg !== "object") return;
  const id = msg.id;

  if (msg.type === "QUEUE_CHANGED") {
    queueRunning = msg.running || 0;
    queueWaiting = msg.waiting || 0;
    updateQueueInfo();
    return;
  }

  if (msg.type === "SUMMARY_STARTED") {
    jobFor(id, msg.page);
    if (isForeground(id)) setStatus("Summarizing…", "live");
    return;
  }

  if (msg.type === "SUMMARY_REASONING") {
    const j = jobFor(id, msg.page);
    j.reasoning += (msg.reasoning || "").length;
    if (isForeground(id) && el.summary.childElementCount === 0) setStatus(`Thinking… (${j.reasoning})`, "live");
    return;
  }

  if (msg.type === "SUMMARY_TOKEN") {
    const j = jobFor(id, msg.page);
    j.buffer += msg.token || "";
    if (isForeground(id)) {
      if (el.summary.childElementCount === 0) setStatus("Summarizing…", "live");
      renderMarkdown(j.buffer);
    }
    return;
  }

  if (msg.type === "SUMMARY_DONE") {
    // Persist from the buffered job (works for background jobs too).
    const j = jobs.get(id);
    if (j && j.page.url && j.buffer.trim()) {
      saveSummary(j.page.url, {
        url: j.page.url,
        title: j.page.title || "",
        siteName: j.page.siteName || "",
        charCount: j.page.charCount || 0,
        summary: j.buffer,
        createdAt: Date.now(),
      });
      renderHistory();
    }
    jobs.delete(id);
    if (isForeground(id)) finishForeground("Done");
    return;
  }

  if (msg.type === "SUMMARY_ERROR") {
    if (isForeground(id)) {
      setStatus("Error: " + (msg.message || "unknown") + (msg.detail ? " — " + msg.detail : ""), "error");
    }
    jobs.delete(id);
    if (isForeground(id)) finishForeground();
    return;
  }

  if (msg.type === "SUMMARY_STOPPED") {
    jobs.delete(id);
    if (isForeground(id)) finishForeground("(stopped)");
    return;
  }
}

// Clear the panel's rendering of the foreground (currently-shown) job.
function finishForeground(statusText) {
  renderJobId = null;
  el.btnStop.classList.add("hidden");
  el.btnRerun.classList.remove("hidden");
  if (statusText && el.status.textContent === "Summarizing…") setStatus(statusText);
  syncEmptyState();
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
  setFavicon(tab.url);

  // Stop painting the previous foreground job in the panel; background jobs
  // (in the worker queue) continue independently and save on completion.
  renderJobId = null;
  el.btnStop.classList.add("hidden");

  // If a job is still running for THIS page, re-attach it as the foreground
  // so the stream stays visible live (it's more current than any saved one).
  let runningForThisPage = null;
  for (const [jid, j] of jobs) {
    if (j.page && j.page.url === currentUrl) { runningForThisPage = { jid, j }; break; }
  }

  if (runningForThisPage) {
    renderJobId = runningForThisPage.jid;
    if (runningForThisPage.j.buffer.trim()) renderMarkdown(runningForThisPage.j.buffer);
    else syncEmptyState();
    setStatus("Summarizing…", "live");
    el.btnStop.classList.remove("hidden");
    el.btnRerun.classList.add("hidden");
    return;
  }

  const cached = await getSummary(currentUrl);
  if (cached && cached.summary) {
    el.summary.innerHTML = DOMPurify.sanitize(parseMD(cached.summary));
    setStatus("Loaded from history");
    el.btnRerun.classList.remove("hidden");
    syncEmptyState();
  } else {
    el.summary.innerHTML = "";
    setStatus("");
    el.btnRerun.classList.add("hidden");
    syncEmptyState();
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
    setFavicon(url);
    renderJobId = null; // stop painting; background jobs continue independently
    el.summary.innerHTML = DOMPurify.sanitize(parseMD(cached.summary));
    setStatus("From history");
    el.btnStop.classList.add("hidden");
    el.btnRerun.classList.remove("hidden");
    syncEmptyState();
  });
}

// --- wiring ---
el.btnSummarize.addEventListener("click", summarizeCurrentPage);
el.btnRerun.addEventListener("click", summarizeCurrentPage);
el.btnStop.addEventListener("click", () => {
  // Cancel the running/queued summary for the shown page in the background.
  if (currentUrl) chrome.runtime.sendMessage({ type: "ENQUEUE_CANCEL", url: currentUrl });
  renderJobId = null;
  el.btnStop.classList.add("hidden");
  setStatus("(stopped)");
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

// Route background messages: tab/navigation changes refresh the panel's
// context; SUMMARY_* / QUEUE_CHANGED drive the serial-queue pipeline.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "TAB_ACTIVATED") {
    refreshForCurrentTab();
  } else if (msg.type && msg.type.startsWith("SUMMARY_")) {
    handleSummaryEvent(msg);
  } else if (msg.type === "QUEUE_CHANGED") {
    handleSummaryEvent(msg);
  }
});

(async function init() {
  fillSettings(await loadSettings());
  // Show the current tab's context (cached summary or the default state).
  await refreshForCurrentTab();
})();
