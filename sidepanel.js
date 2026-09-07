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

let lastPage = null;
let port = null;
let accText = "";
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

const $ = (id) => document.getElementById(id);
const el = {
  pageInfo: $("page-info"), pageTitle: $("page-title"), pageMeta: $("page-meta"),
  btnSummarize: $("btn-summarize"), btnRerun: $("btn-rerun"), btnStop: $("btn-stop"),
  status: $("status"), summary: $("summary"),
  setBaseUrl: $("set-baseurl"), setApiKey: $("set-apikey"), setModel: $("set-model"),
  setMaxLength: $("set-maxlength"),
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

// --- pipeline ---
function startSummarize(page, settings) {
  accText = "";
  let reasoningCount = 0;
  el.summary.innerHTML = "";
  el.btnStop.classList.remove("hidden");
  el.btnRerun.classList.add("hidden");
  setStatus("Summarizing…");

  port = chrome.runtime.connect({ name: "summarize" });
  port.onMessage.addListener((msg) => {
    // Reasoning models (e.g. Qwen3) "think" first via delta.reasoning_content.
    // Show live progress so the panel doesn't look stuck; the real answer is
    // streamed below via `msg.token` once chain-of-thought finishes.
    if (msg.reasoning) {
      reasoningCount += msg.reasoning.length;
      if (el.summary.childElementCount === 0) setStatus(`Thinking… (${reasoningCount})`);
    } else if (msg.token) {
      if (el.summary.childElementCount === 0) setStatus("Summarizing…");
      accText += msg.token;
      renderMarkdown(accText);
    } else if (msg.done) {
      // Persist the finished summary keyed by the page URL (local db).
      if (currentUrl && accText.trim()) {
        saveSummary(currentUrl, {
          url: currentUrl,
          title: (lastPage && lastPage.title) || "",
          siteName: (lastPage && lastPage.siteName) || "",
          charCount: (lastPage && lastPage.charCount) || 0,
          summary: accText,
          createdAt: Date.now(),
        });
      }
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
    maxTokens: MAX_LENGTH_TOKENS[settings.maxLength] || MAX_LENGTH_TOKENS.medium,
    maxInputChars: settings.maxInputChars, page,
  });
}

function finalize(statusText) {
  if (!port) return; // already cleaned up (e.g. by a tab-switch refresh)
  port.disconnect();
  port = null;
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

  if (port) { port.disconnect(); port = null; }
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

// --- wiring ---
el.btnSummarize.addEventListener("click", summarizeCurrentPage);
el.btnRerun.addEventListener("click", summarizeCurrentPage);
el.btnStop.addEventListener("click", () => { if (port) port.postMessage({ cancel: true }); });
el.btnSave.addEventListener("click", saveSettings);

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
