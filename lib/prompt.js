// Pure prompt/message building. No DOM. Testable in Node.

export const SYSTEM_PROMPT = [
  "You are a precise summarization assistant.",
  "Summarize ONLY the article text provided by the user.",
  "Reply in the same language as the article text provided by the user.",
  'Ground your summary in the source: include a few short verbatim quotes (in "double quotes") that support the key points.',
  "Respond in Markdown with exactly three parts, in order:",
  "1. **TL;DR** - one or two sentences.",
  "2. **Key points** - a bulleted list.",
  "3. **Takeaway** - a single line.",
  "Match the depth to the length and substance of the content: keep it brief for short or thin pages, and be more detailed for long, rich ones.",
  "If the source is thin, keep the summary brief and say so.",
  "Output only the summary - no preamble, no commentary.",
].join("\n");

export function truncateText(text, maxChars) {
  if (maxChars == null || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export const CHAT_SYSTEM_PROMPT = [
  "You are a precise question-answering assistant.",
  "The user shares a web page (its title, URL, article text, and a summary) and then asks questions about that page.",
  "Ground every claim in the provided page text and summary. If they do not contain the answer, say so plainly instead of guessing.",
  "Reply in the same language as the page text.",
  "Respond in Markdown.",
].join("\n");

// The single user message that carries the page to the chat model: header,
// article text (capped), and the summary. When no text was stored for the
// page (e.g. summaries from before text storage existed), it says so and the
// model answers from the summary alone.
export function buildPageContext(page, summary, maxInputChars) {
  const { text, truncated } = truncateText(page?.text || "", maxInputChars);
  const lines = [];
  if (page?.title) lines.push(`Title: ${page.title}`);
  if (page?.siteName) lines.push(`Site: ${page.siteName}`);
  if (page?.url) lines.push(`URL: ${page.url}`);
  if (truncated) lines.push("(Note: the source text was truncated to fit the model.)");
  lines.push("");
  if (text) {
    lines.push("Article text:", "", text, "");
  } else if (summary) {
    lines.push("(Note: only the summary is available for this page; answer from it.)", "");
  }
  if (summary) lines.push("Summary of the page:", "", summary);
  return lines.join("\n");
}

// Messages for one chat turn: system prompt, page context, the earlier
// conversation (user/assistant, in order), then the new question.
export function buildChatMessages(page, summary, history, question, maxInputChars) {
  const messages = [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    { role: "user", content: buildPageContext(page, summary, maxInputChars) },
  ];
  for (const turn of Array.isArray(history) ? history : []) {
    if (turn && typeof turn.q === "string" && turn.q.trim()) {
      messages.push({ role: "user", content: turn.q });
    }
    if (turn && typeof turn.a === "string" && turn.a.trim()) {
      messages.push({ role: "assistant", content: turn.a });
    }
  }
  messages.push({ role: "user", content: question });
  return messages;
}

export function buildMessages(page, maxInputChars) {
  // Same page-context block as the chat (buildPageContext), without a summary.
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildPageContext(page, "", maxInputChars) },
  ];
}
