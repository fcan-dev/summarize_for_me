// Pure settings logic: defaults, merge, legacy migration. No chrome.*, no DOM.
// Testable in Node.

export const ENDPOINT_IDS = ["1", "2"];

export const DEFAULTS = {
  endpoints: {
    // Endpoint 1 is prefilled with local-dev placeholders; Endpoint 2 starts
    // empty until the user configures it.
    "1": { baseUrl: "http://localhost:8000/v1", apiKey: "local", model: "your-model" },
    "2": { baseUrl: "", apiKey: "", model: "" },
  },
  activeEndpoint: "1",
  maxLength: "medium",
  maxInputChars: 100000,
};

export function endpointLabel(id) {
  return ENDPOINT_IDS.includes(id) ? `Endpoint ${id}` : `Endpoint ${ENDPOINT_IDS[0]}`;
}

// Categorical summary length -> max output tokens sent to the model.
export const LENGTH_TOKENS = { short: 512, medium: 1024, long: 2048 };

// Token cap for a summary length; unknown/missing values fall back to the default.
export function maxTokensForLength(length) {
  return LENGTH_TOKENS[length] ?? LENGTH_TOKENS[DEFAULTS.maxLength];
}

function normalizeEndpoint(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    baseUrl: String(r.baseUrl || "").trim(),
    apiKey: String(r.apiKey || "").trim(),
    model: String(r.model || "").trim(),
  };
}

// Merge raw storage values into the settings shape. Missing keys fall back to
// defaults; explicitly saved values (including empty strings) are kept as-is.
export function mergeSettings(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  const endpoints = {};
  for (const id of ENDPOINT_IDS) {
    const fromStore = s.endpoints && typeof s.endpoints === "object" ? s.endpoints[id] : undefined;
    endpoints[id] = normalizeEndpoint(fromStore !== undefined ? fromStore : DEFAULTS.endpoints[id]);
  }
  return {
    endpoints,
    activeEndpoint: ENDPOINT_IDS.includes(s.activeEndpoint) ? s.activeEndpoint : ENDPOINT_IDS[0],
    maxLength: typeof s.maxLength === "string" && s.maxLength ? s.maxLength : DEFAULTS.maxLength,
    maxInputChars: Number.isFinite(s.maxInputChars) && s.maxInputChars > 0 ? s.maxInputChars : DEFAULTS.maxInputChars,
  };
}

// Migrate legacy single-endpoint settings ({ baseUrl, apiKey, model, ... }) to
// the two-endpoint schema: the old values become Endpoint 1. No-op when the
// new `endpoints` key is already present (it wins).
export function migrateSettings(stored) {
  const s = stored && typeof stored === "object" ? { ...stored } : {};
  const hasNew = s.endpoints && typeof s.endpoints === "object";
  const hasLegacy = !!(s.baseUrl || s.apiKey || s.model);
  if (!hasNew && hasLegacy) {
    s.endpoints = {
      "1": normalizeEndpoint(s),
      "2": { ...DEFAULTS.endpoints["2"] },
    };
  }
  return mergeSettings(s);
}

// The endpoint a summary job should use, or null when it is not configured
// (missing base URL or model).
export function activeEndpoint(settings) {
  const id = ENDPOINT_IDS.includes(settings.activeEndpoint) ? settings.activeEndpoint : ENDPOINT_IDS[0];
  const ep = settings.endpoints && settings.endpoints[id];
  if (!ep || !ep.baseUrl || !ep.model) return null;
  return { id, baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model };
}
