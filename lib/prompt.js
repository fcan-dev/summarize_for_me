// Pure prompt/message building. No DOM. Testable in Node.

export const SYSTEM_PROMPT = [
  "You are a precise summarization assistant.",
  "Summarize ONLY the article text provided by the user.",
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

export function buildMessages(page, maxInputChars) {
  const { text, truncated } = truncateText(page?.text || "", maxInputChars);
  const lines = [];
  if (page?.title) lines.push(`Title: ${page.title}`);
  if (page?.siteName) lines.push(`Site: ${page.siteName}`);
  if (page?.url) lines.push(`URL: ${page.url}`);
  if (truncated) lines.push("(Note: the source text was truncated to fit the model.)");
  lines.push("", "Article text:", "");
  const header = lines.join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${header}\n${text}` },
  ];
}
