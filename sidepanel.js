// sidepanel.js — UI: settings, endpoint switcher, pipeline trigger, streaming markdown render (module).
import { DEFAULTS, ENDPOINT_IDS, activeEndpoint, endpointLabel, maxTokensForLength, migrateSettings } from "./lib/settings.js";
import { buildChatMessages } from "./lib/prompt.js";
import { withChatTurn, clearChat } from "./lib/chat.js";
import { extractDataPayloads, tokenFromPayload } from "./lib/sse.js";

let currentUrl = null; // URL of the page the panel is currently showing
let settings = null; // merged settings: two endpoints + which one is active

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
  epBtn1: $("ep-btn-1"), epBtn2: $("ep-btn-2"),
  setBaseUrl1: $("set-baseurl-1"), setApiKey1: $("set-apikey-1"), setModel1: $("set-model-1"),
  setBaseUrl2: $("set-baseurl-2"), setApiKey2: $("set-apikey-2"), setModel2: $("set-model-2"),
  setMaxLength: $("set-maxlength"),
  btnSave: $("btn-save"), saveNote: $("save-note"),
  history: $("history"), historyList: $("history-list"),
  chat: $("chat"), chatMessages: $("chat-messages"),
  chatInput: $("chat-input"), btnChatSend: $("btn-chat-send"), btnChatNew: $("btn-chat-new"),
};

// --- storage (chrome.storage.local only — settings never leave this browser) ---
async function loadSettings() {
  const stored = await chrome.storage.local.get(["endpoints", "activeEndpoint", "maxLength", "maxInputChars"]);
  return migrateSettings(stored);
}

// --- settings UI ---
function fillSettings(s) {
  for (const id of ENDPOINT_IDS) {
    el["setBaseUrl" + id].value = s.endpoints[id].baseUrl;
    el["setApiKey" + id].value = s.endpoints[id].apiKey;
    el["setModel" + id].value = s.endpoints[id].model;
  }
  el.setMaxLength.value = s.maxLength || DEFAULTS.maxLength;
}
async function saveSettings() {
  const endpoints = {};
  for (const id of ENDPOINT_IDS) {
    endpoints[id] = {
      baseUrl: el["setBaseUrl" + id].value.trim(),
      apiKey: el["setApiKey" + id].value.trim(),
      model: el["setModel" + id].value.trim(),
    };
  }
  await chrome.storage.local.set({
    endpoints,
    maxLength: el.setMaxLength.value || DEFAULTS.maxLength,
  });
  settings = await loadSettings();
  el.saveNote.classList.remove("hidden");
  setTimeout(() => el.saveNote.classList.add("hidden"), 1500);
}

// --- endpoint switcher ---
// Persists immediately (no Save button): the switch is a per-run choice, not
// part of the endpoint configuration.
function renderEndpointSwitch() {
  for (const id of ENDPOINT_IDS) {
    el["epBtn" + id].setAttribute("aria-pressed", String(settings.activeEndpoint === id));
  }
}
async function selectEndpoint(id) {
  if (!settings || !ENDPOINT_IDS.includes(id) || settings.activeEndpoint === id) return;
  settings.activeEndpoint = id;
  await chrome.storage.local.set({ activeEndpoint: id });
  renderEndpointSwitch();
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
  const ep = activeEndpoint(settings);
  if (!ep) {
    setStatus(`Configure ${endpointLabel(settings.activeEndpoint)} in Settings first.`, "error");
    return;
  }
  currentUrl = (page && page.url) || currentUrl;

  resetChat(); // the summary area is about to be cleared
  el.summary.innerHTML = "";
  el.emptyState.classList.add("hidden");
  el.btnStop.classList.remove("hidden");
  el.btnRerun.classList.add("hidden");
  setStatus("Queuing…", "live");

  // The job carries a snapshot of the selected endpoint and the resolved
  // token cap: switching the switch or the length mid-queue does not
  // redirect in-flight or queued jobs.
  const res = await new Promise((resolve) =>
    chrome.runtime.sendMessage(
      {
        type: "ENQUEUE",
        page,
        settings: { endpoint: ep, maxInputChars: settings.maxInputChars, maxTokens: maxTokensForLength(settings.maxLength) },
      },
      resolve
    )
  );
  if (res && res.id != null) {
    jobFor(res.id, page); // start buffering this job
    renderJobId = res.id; // and paint it (it's the current view's summary)
  }
  setStatus("Summarizing…", "live");
}

// Handle a summary-progress event broadcast by the background worker.
async function handleSummaryEvent(msg) {
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
    const fg = isForeground(id);
    if (j && j.page.url && j.buffer.trim()) {
      const prev = await getSummary(j.page.url);
      const record = {
        url: j.page.url,
        title: j.page.title || "",
        siteName: j.page.siteName || "",
        charCount: j.page.charCount || 0,
        summary: j.buffer,
        text: j.page.text || "", // stored so later chat can ground answers in the full page
        createdAt: Date.now(),
      };
      // A re-summary must not wipe an existing conversation for the page.
      if (prev && Array.isArray(prev.chat) && prev.chat.length) record.chat = prev.chat;
      saveSummary(record.url, record);
      renderHistory();
      if (fg) { finishForeground("Done"); showChat(record); }
    }
    jobs.delete(id);
    if (fg) finishForeground("Done");
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

// --- chat (ask about the page) ---
// The conversation is persisted per page inside the summary record
// (record.chat); this state only tracks the currently shown page and the
// in-flight turn, if any.
const chat = {
  url: null, // page whose conversation is shown
  busy: false, // a turn is streaming
  buffer: "", // current answer buffer
  reasoning: 0, // reasoning chars seen this turn (for the “Thinking…” state)
  controller: null, // AbortController of the in-flight request
};

function hideChat() {
  el.chat.classList.add("hidden");
  el.chatMessages.innerHTML = "";
}

// Abort the in-flight turn (if any) and clear the transient chat state.
function clearChatState() {
  if (chat.controller) {
    chat.controller.abort();
    chat.controller = null;
  }
  chat.busy = false;
  chat.buffer = "";
  chat.reasoning = 0;
  syncChatButtons();
}

// Switch the shown page: abort any in-flight turn and hide the chat.
function resetChat() {
  clearChatState();
  chat.url = null;
  hideChat();
}

function syncChatButtons() {
  el.btnChatSend.disabled = chat.busy;
  el.chatInput.disabled = chat.busy;
}

// Render one Q&A bubble pair into the message list.
function appendTurnDom(question, answer, streaming) {
  const wrap = document.createElement("div");
  wrap.className = "chat-turn";
  const q = document.createElement("div");
  q.className = "chat-q";
  q.textContent = question;
  const a = document.createElement("div");
  a.className = "chat-a markdown" + (streaming ? " streaming" : "");
  a.innerHTML = streaming
    ? '<span class="chat-thinking">Thinking…</span>'
    : DOMPurify.sanitize(parseMD(answer || ""));
  wrap.append(q, a);
  el.chatMessages.appendChild(wrap);
  return { wrap, a };
}

// Show the chat for a stored record: render its conversation (if any) and
// make the input ready.
function showChat(record) {
  clearChatState();
  chat.url = record.url;
  el.chatMessages.innerHTML = "";
  for (const t of Array.isArray(record.chat) ? record.chat : []) {
    appendTurnDom(t.q || "", t.a || "", false);
  }
  el.chat.classList.remove("hidden");
  syncChatButtons();
}

async function sendChat() {
  if (chat.busy || !chat.url) return;
  const question = el.chatInput.value.trim();
  if (!question) return;

  const ep = activeEndpoint(settings);
  if (!ep) {
    return setStatus(`Configure ${endpointLabel(settings.activeEndpoint)} in Settings first.`, "error");
  }
  const record = await getSummary(chat.url);
  if (!record || !record.summary || record.url !== chat.url) return;

  const controller = new AbortController();
  chat.busy = true;
  chat.buffer = "";
  chat.reasoning = 0;
  chat.controller = controller;
  syncChatButtons();
  el.chatInput.value = "";

  const { wrap, a } = appendTurnDom(question, "", true);

  const messages = buildChatMessages(
    { title: record.title || "", siteName: record.siteName || "", url: record.url, text: record.text || "" },
    record.summary,
    Array.isArray(record.chat) ? record.chat : [],
    question,
    settings.maxInputChars,
  );

  try {
    const res = await fetch(`${String(ep.baseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify({ model: ep.model, messages, stream: true }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? " — " + body.slice(0, 300) : ""}`);
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
        if (isDone) break;
        if (token) {
          chat.buffer += token;
          a.innerHTML = DOMPurify.sanitize(parseMD(chat.buffer));
        } else if (reasoning) {
          chat.reasoning += reasoning.length;
          if (!chat.buffer) a.innerHTML = `<span class="chat-thinking">Thinking… (${chat.reasoning})</span>`;
        }
      }
    }
    // Persist the completed turn (withChatTurn preserves text/summary).
    const updated = withChatTurn(record, question, chat.buffer.trim(), Date.now());
    await saveSummary(updated.url, updated);
    a.classList.remove("streaming");
    if (!chat.buffer.trim()) a.innerHTML = '<span class="chat-thinking">(no answer received)</span>';
  } catch (e) {
    if (e && e.name === "AbortError") {
      // Page switched / new chat: drop the in-flight turn entirely.
      wrap.remove();
    } else {
      a.classList.remove("streaming");
      a.innerHTML = `<span class="chat-error">${escapeHtml((e && e.message) || "Request failed")}</span>`;
    }
  } finally {
    // Only reset if this turn is still the current one (a newer turn or a
    // page switch may already have superseded it).
    if (chat.controller === controller) {
      chat.controller = null;
      chat.busy = false;
      syncChatButtons();
    }
  }
}

// Start a fresh conversation for the shown page (drops the stored one).
async function newChat() {
  clearChatState();
  if (!chat.url) return;
  const record = await getSummary(chat.url);
  if (!record) return;
  const updated = clearChat(record);
  await saveSummary(updated.url, updated);
  el.chatMessages.innerHTML = "";
  syncChatButtons();
  el.chatInput.focus();
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

  resetChat(); // abort any in-flight chat for the previous page

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
    showChat(cached);
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
    resetChat();
    el.summary.innerHTML = DOMPurify.sanitize(parseMD(cached.summary));
    setStatus("From history");
    el.btnStop.classList.add("hidden");
    el.btnRerun.classList.remove("hidden");
    syncEmptyState();
    showChat(cached);
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
el.epBtn1.addEventListener("click", () => selectEndpoint("1"));
el.epBtn2.addEventListener("click", () => selectEndpoint("2"));
el.btnChatSend.addEventListener("click", sendChat);
el.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
el.btnChatNew.addEventListener("click", newChat);

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
  settings = await loadSettings();
  fillSettings(settings);
  renderEndpointSwitch();
  // Show the current tab's context (cached summary or the default state).
  await refreshForCurrentTab();
})();
