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
