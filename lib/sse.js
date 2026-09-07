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
export function tokenFromPayload(payload) {
  if (payload === "[DONE]") return { done: true, token: "" };
  try {
    const obj = JSON.parse(payload);
    const token = obj?.choices?.[0]?.delta?.content ?? "";
    return { done: false, token };
  } catch {
    return { done: false, token: "" };
  }
}
