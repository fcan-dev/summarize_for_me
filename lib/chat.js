// Pure helpers for the per-page conversation stored inside a summary record.
// No DOM, no chrome.*. Testable in Node.

// Append one completed Q&A turn to a stored summary record, returning a new
// record. Every other field — notably the stored `text` and `summary` — is
// preserved so a chat save can never clobber the page context.
export function withChatTurn(record, question, answer, ts) {
  const turns = Array.isArray(record.chat) ? record.chat : [];
  return { ...record, chat: [...turns, { q: question, a: answer, ts }] };
}

// Empty the conversation, keeping the rest of the record intact.
export function clearChat(record) {
  return { ...record, chat: [] };
}
