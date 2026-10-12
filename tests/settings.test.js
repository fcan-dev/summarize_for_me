import test from "node:test";
import assert from "node:assert";
import {
  DEFAULTS,
  ENDPOINT_IDS,
  activeEndpoint,
  endpointLabel,
  maxTokensForLength,
  mergeSettings,
  migrateSettings,
} from "../lib/settings.js";

test("mergeSettings with no storage returns defaults (endpoint 1 prefilled, endpoint 2 empty)", () => {
  const s = mergeSettings({});
  assert.equal(s.endpoints["1"].baseUrl, DEFAULTS.endpoints["1"].baseUrl);
  assert.equal(s.endpoints["1"].model, "your-model");
  assert.deepEqual(s.endpoints["2"], { baseUrl: "", apiKey: "", model: "" });
  assert.equal(s.activeEndpoint, "1");
  assert.equal(s.maxLength, "medium");
  assert.equal(s.maxInputChars, 100000);
});

test("mergeSettings keeps user-saved values over defaults", () => {
  const s = mergeSettings({
    endpoints: {
      "1": { baseUrl: "http://a:1/v1", apiKey: "k1", model: "m1" },
      "2": { baseUrl: "http://b:2/v1", apiKey: "", model: "m2" },
    },
    activeEndpoint: "2",
    maxLength: "long",
    maxInputChars: 5000,
  });
  assert.equal(s.endpoints["1"].baseUrl, "http://a:1/v1");
  assert.equal(s.endpoints["2"].baseUrl, "http://b:2/v1");
  assert.equal(s.endpoints["2"].model, "m2");
  assert.equal(s.activeEndpoint, "2");
  assert.equal(s.maxLength, "long");
  assert.equal(s.maxInputChars, 5000);
});

test("mergeSettings does not re-inject defaults for an explicitly emptied endpoint", () => {
  const s = mergeSettings({
    endpoints: { "1": { baseUrl: "", apiKey: "", model: "" }, "2": { baseUrl: "", apiKey: "", model: "" } },
  });
  assert.equal(s.endpoints["1"].baseUrl, "");
  assert.equal(s.endpoints["1"].model, "");
});

test("mergeSettings trims whitespace from stored endpoint values", () => {
  const s = mergeSettings({ endpoints: { "1": { baseUrl: " http://x/v1 ", apiKey: " k ", model: " m " } } });
  assert.deepEqual(s.endpoints["1"], { baseUrl: "http://x/v1", apiKey: "k", model: "m" });
});

test("mergeSettings rejects an unknown activeEndpoint id", () => {
  const s = mergeSettings({ activeEndpoint: "9" });
  assert.equal(s.activeEndpoint, "1");
});

test("migrateSettings moves legacy single-endpoint values into Endpoint 1", () => {
  const s = migrateSettings({
    baseUrl: "http://gpu:8091/v1",
    apiKey: "secret",
    model: "qwen",
    maxLength: "short",
  });
  assert.equal(s.endpoints["1"].baseUrl, "http://gpu:8091/v1");
  assert.equal(s.endpoints["1"].apiKey, "secret");
  assert.equal(s.endpoints["1"].model, "qwen");
  assert.deepEqual(s.endpoints["2"], { baseUrl: "", apiKey: "", model: "" });
  assert.equal(s.maxLength, "short");
});

test("migrateSettings leaves new-shape settings untouched when both shapes exist", () => {
  const s = migrateSettings({
    baseUrl: "http://legacy/v1",
    model: "legacy-model",
    endpoints: { "1": { baseUrl: "http://new/v1", apiKey: "", model: "m" }, "2": { baseUrl: "", apiKey: "", model: "" } },
  });
  assert.equal(s.endpoints["1"].baseUrl, "http://new/v1");
  assert.equal(s.endpoints["1"].model, "m");
});

test("migrateSettings with nothing returns defaults", () => {
  const s = migrateSettings(undefined);
  assert.equal(s.endpoints["1"].baseUrl, DEFAULTS.endpoints["1"].baseUrl);
  assert.equal(s.endpoints["2"].baseUrl, "");
});

test("activeEndpoint returns the selected configured endpoint", () => {
  const s = mergeSettings({
    endpoints: {
      "1": { baseUrl: "http://a/v1", apiKey: "ka", model: "ma" },
      "2": { baseUrl: "http://b/v1", apiKey: "kb", model: "mb" },
    },
    activeEndpoint: "2",
  });
  assert.deepEqual(activeEndpoint(s), { id: "2", baseUrl: "http://b/v1", apiKey: "kb", model: "mb" });
});

test("activeEndpoint returns null for an unconfigured endpoint", () => {
  const s = mergeSettings({ endpoints: { "1": { baseUrl: "", apiKey: "", model: "" }, "2": { baseUrl: "", apiKey: "", model: "" } } });
  assert.equal(activeEndpoint(s), null);
});

test("activeEndpoint treats a missing model as unconfigured", () => {
  const s = mergeSettings({ endpoints: { "1": { baseUrl: "http://a/v1", apiKey: "", model: "" } } });
  assert.equal(activeEndpoint(s), null);
});

test("activeEndpoint falls back to endpoint 1 for an unknown selection", () => {
  const s = mergeSettings({ activeEndpoint: "9", endpoints: { "1": { baseUrl: "http://a/v1", apiKey: "", model: "m" } } });
  const ep = activeEndpoint(s);
  assert.equal(ep.id, "1");
  assert.equal(ep.baseUrl, "http://a/v1");
});

test("endpointLabel names both endpoints", () => {
  assert.deepEqual(ENDPOINT_IDS, ["1", "2"]);
  assert.equal(endpointLabel("1"), "Endpoint 1");
  assert.equal(endpointLabel("2"), "Endpoint 2");
  assert.equal(endpointLabel("bogus"), "Endpoint 1");
});

test("maxTokensForLength maps each summary length to its token cap", () => {
  assert.equal(maxTokensForLength("short"), 512);
  assert.equal(maxTokensForLength("medium"), 1024);
  assert.equal(maxTokensForLength("long"), 2048);
});

test("maxTokensForLength falls back to the default (medium) for unknown values", () => {
  assert.equal(maxTokensForLength("bogus"), 1024);
  assert.equal(maxTokensForLength(undefined), 1024);
});
