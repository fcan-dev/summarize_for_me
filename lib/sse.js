// Pure SSE parsing helpers. No DOM, no fetch. Testable in Node.

// Splits a raw SSE text buffer into complete `data:` payload strings.
// An incomplete trailing line (buffer not ending in "\n") is returned as `rest`.
export function extractDataPayloads(buffer) {
  const payloads = [];
  const lines = buffer.split("\n");
  let rest = "";
  if (!buffer.endsWith("\n")) {
    rest = lines.pop() ?? "";
  }
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload !== "") payloads.push(payload);
  }
  return { payloads, rest };
}

// Interprets a single data payload: [DONE] sentinel or a chat-completion chunk.
// Reasoning models (e.g. Qwen3) emit `delta.reasoning_content` tokens before
// any `delta.content`; we surface those separately so the UI can show progress
// instead of appearing stuck during the chain-of-thought phase.
export function tokenFromPayload(payload) {
  if (payload === "[DONE]") return { done: true, token: "", reasoning: "" };
  try {
    const obj = JSON.parse(payload);
    const delta = obj?.choices?.[0]?.delta ?? {};
    const token = delta.content ?? "";
    const reasoning = delta.reasoning_content ?? "";
    return { done: false, token, reasoning };
  } catch {
    return { done: false, token: "", reasoning: "" };
  }
}
