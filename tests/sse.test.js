import test from "node:test";
import assert from "node:assert";
import { extractDataPayloads, tokenFromPayload } from "../lib/sse.js";

test("extractDataPayloads parses complete data lines", () => {
  const { payloads, rest } = extractDataPayloads('data: {"a":1}\ndata: {"b":2}\n');
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, "");
});

test("extractDataPayloads carries an incomplete trailing line as rest", () => {
  const { payloads, rest } = extractDataPayloads('data: {"a":1}\ndata: {"b":');
  assert.deepEqual(payloads, ['{"a":1}']);
  assert.equal(rest, 'data: {"b":');
});

test("extractDataPayloads ignores non-data and blank lines", () => {
  const { payloads } = extractDataPayloads('event: message\n\n: comment\ndata: {"a":1}\n');
  assert.deepEqual(payloads, ['{"a":1}']);
});

test("tokenFromPayload returns the content token", () => {
  const { done, token } = tokenFromPayload('{"choices":[{"delta":{"content":"Hel"}}]}');
  assert.equal(done, false);
  assert.equal(token, "Hel");
});

test("tokenFromPayload handles [DONE]", () => {
  assert.deepEqual(tokenFromPayload("[DONE]"), { done: true, token: "", reasoning: "" });
});

test("tokenFromPayload returns empty when delta.content is absent", () => {
  const { done, token } = tokenFromPayload('{"choices":[{"delta":{}}]}');
  assert.equal(done, false);
  assert.equal(token, "");
});

test("tokenFromPayload returns empty for malformed JSON", () => {
  const { done, token } = tokenFromPayload("not json");
  assert.equal(done, false);
  assert.equal(token, "");
});

test("tokenFromPayload surfaces reasoning_content separately for reasoning models", () => {
  const { done, token, reasoning } = tokenFromPayload(
    '{"choices":[{"delta":{"reasoning_content":"The user"}}]}'
  );
  assert.equal(done, false);
  assert.equal(token, "");
  assert.equal(reasoning, "The user");
});

test("tokenFromPayload returns content when present alongside reasoning", () => {
  const { token, reasoning } = tokenFromPayload(
    '{"choices":[{"delta":{"reasoning_content":"...","content":"Hello"}}]}'
  );
  assert.equal(token, "Hello");
  assert.equal(reasoning, "...");
});
