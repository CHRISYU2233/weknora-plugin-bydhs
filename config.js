/** Plugin configuration: shape, defaults, and load-time validation. */

const DEFAULTS = {
  baseUrl: 'http://localhost:8080/api/v1',
  maxResults: 6,
  maxChunkChars: 1500,
  requestTimeoutMs: 30_000,
  chatTimeoutMs: 300_000,
  resourceUrls: 'handle',
  toolPrefix: 'wkg',
  enforce: true,
  // Name of the entry in the deployment's credential store, used when the row
  // carries no inline apiKey.
  apiKeyRef: 'WEKNORA_API_KEY',
  // --- grounding behaviour (v0.2) ---
  // Inject retrieved evidence into the entering user message at agent/pre-step,
  // so "search first" happens even if the model would not call the tool.
  injectEvidence: true,
  // Position of the policy section. First-party sections continue at 10000
  // (harness source), 10100 (web surface) and 10200 (deployment persona
  // suffix), so 10500 is the last word; 5100 (the v0.1 default) rendered
  // mid-prompt.
  policyOrder: 10_500,
  // A message shorter than this is treated as chit-chat and not grounded.
  minQueryChars: 8,
  // Deterministic quality gate: lexical query-term coverage a passage must
  // reach before it counts as evidence. Scale-free, unlike WeKnora's score.
  minCoverage: 0.34,
  // Optional absolute score floor. Leave unset unless the deployment's search
  // returns normalised 0..1 scores; the coverage gate is the portable one.
  minScore: undefined,
  // Character budget for one injected evidence block.
  maxInjectedChars: 4_000,
  // Passages to request for the pre-step injection (tool calls use maxResults).
  injectTopK: 6,
  // Cap sampling temperature on grounded sessions. `null` disables the cap.
  temperatureCap: 0.2,
  // With several knowledge bases, query them one by one so one broken
  // deployment cannot empty the whole result set.
  perKbIsolation: true,
  // Platform-scoped API keys need X-Tenant-ID; project-scoped keys leave it empty.
  tenantId: undefined,
  // Extra request headers for gateways/proxies in front of WeKnora.
  extraHeaders: undefined,
  // Retries for transient failures (429/5xx/network). 0 disables retrying.
  maxRetries: 1,
  // Character budget for one wiki page returned by the wiki tools.
  maxWikiChars: 8_000,
};

/** Thrown when a patch row configures this plugin in a way it cannot serve. */
export class ConfigError extends Error {
  constructor(violations) {
    super(`WeKnora_plugin_byDHS configuration is invalid:\n  - ${violations.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const API_ROOT = /\/api\/v\d+$/;
const TOOL_PREFIX = /^[a-z][a-z0-9_]*$/;

/** Normalize a WeKnora base URL to an API root, accepting bare origins too. */
export function normalizeBaseUrl(raw) {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return API_ROOT.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

function positiveInt(value, field, violations) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    violations.push(`${field} must be a positive number, received ${JSON.stringify(value)}`);
    return undefined;
  }
  return Math.floor(value);
}

function integer(value, field, violations) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    violations.push(`${field} must be an integer, received ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

function boundedInt(value, field, violations, min, max) {
  const parsed = integer(value, field, violations);
  if (parsed === undefined) return undefined;
  if (parsed < min || parsed > max) {
    violations.push(`${field} must be between ${min} and ${max}, received ${parsed}`);
    return undefined;
  }
  return parsed;
}

function stringMap(value, field, violations) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    violations.push(`${field} must be an object of string values`);
    return undefined;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      violations.push(`${field}.${key} must be a string`);
      continue;
    }
    out[key] = entry;
  }
  return out;
}

function unitNumber(value, field, violations) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    violations.push(`${field} must be a number between 0 and 1, received ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

function booleanField(value, field, violations) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    violations.push(`${field} must be a boolean, received ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

function stringList(value, field, violations) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    violations.push(`${field} must be an array of non-empty strings`);
    return undefined;
  }
  return value.map((entry) => entry.trim());
}

function optionalString(value, field, violations) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    violations.push(`${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Apply defaults and reject an unusable row while the plugin loads, so a typo
 * surfaces at boot rather than inside the first tool call the model makes.
 * @param raw - the `config` value from the Cordis row.
 */
export function resolveConfig(raw) {
  const violations = [];
  const config = raw ?? {};
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError(['config must be an object']);
  }
  const baseUrlInput = optionalString(config.baseUrl, 'baseUrl', violations) ?? DEFAULTS.baseUrl;
  let baseUrl = DEFAULTS.baseUrl;
  try {
    const url = new URL(normalizeBaseUrl(baseUrlInput));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      violations.push(`baseUrl must use http or https, received ${url.protocol}`);
    }
    baseUrl = url.toString().replace(/\/+$/, '');
  } catch {
    violations.push(`baseUrl must be an absolute URL, received ${JSON.stringify(baseUrlInput)}`);
  }
  const resourceUrls = config.resourceUrls ?? DEFAULTS.resourceUrls;
  if (resourceUrls !== 'handle' && resourceUrls !== 'public') {
    violations.push(`resourceUrls must be "handle" or "public", received ${JSON.stringify(resourceUrls)}`);
  }
  const toolPrefix = optionalString(config.toolPrefix, 'toolPrefix', violations) ?? DEFAULTS.toolPrefix;
  if (!TOOL_PREFIX.test(toolPrefix)) {
    violations.push(`toolPrefix must match ${String(TOOL_PREFIX)}, received ${JSON.stringify(toolPrefix)}`);
  }
  const enforce = booleanField(config.enforce, 'enforce', violations);
  const injectEvidence = booleanField(config.injectEvidence, 'injectEvidence', violations);
  const perKbIsolation = booleanField(config.perKbIsolation, 'perKbIsolation', violations);
  const policyOrder = integer(config.policyOrder, 'policyOrder', violations);
  const minQueryChars = positiveInt(config.minQueryChars, 'minQueryChars', violations);
  const maxInjectedChars = positiveInt(config.maxInjectedChars, 'maxInjectedChars', violations);
  const injectTopK = positiveInt(config.injectTopK, 'injectTopK', violations);
  const minCoverage = unitNumber(config.minCoverage, 'minCoverage', violations);
  const minScore = unitNumber(config.minScore, 'minScore', violations);
  const maxRetries = boundedInt(config.maxRetries, 'maxRetries', violations, 0, 5);
  const maxWikiChars = positiveInt(config.maxWikiChars, 'maxWikiChars', violations);
  const tenantId = optionalString(config.tenantId, 'tenantId', violations);
  const extraHeaders = stringMap(config.extraHeaders, 'extraHeaders', violations);
  let temperatureCap;
  if (config.temperatureCap === undefined) temperatureCap = DEFAULTS.temperatureCap;
  else if (config.temperatureCap === null) temperatureCap = null;
  else if (typeof config.temperatureCap !== 'number' || !Number.isFinite(config.temperatureCap) || config.temperatureCap < 0 || config.temperatureCap > 2) {
    violations.push(`temperatureCap must be null or a number between 0 and 2, received ${JSON.stringify(config.temperatureCap)}`);
  } else temperatureCap = config.temperatureCap;

  const resolved = {
    baseUrl,
    apiKey: optionalString(config.apiKey, 'apiKey', violations),
    // Credential-store reference used when apiKey is not given inline.
    apiKeyRef: optionalString(config.apiKeyRef, 'apiKeyRef', violations) ?? DEFAULTS.apiKeyRef,
    knowledgeBaseIds: stringList(config.knowledgeBaseIds, 'knowledgeBaseIds', violations) ?? [],
    agentId: optionalString(config.agentId, 'agentId', violations),
    maxResults: positiveInt(config.maxResults, 'maxResults', violations) ?? DEFAULTS.maxResults,
    maxChunkChars: positiveInt(config.maxChunkChars, 'maxChunkChars', violations) ?? DEFAULTS.maxChunkChars,
    requestTimeoutMs: positiveInt(config.requestTimeoutMs, 'requestTimeoutMs', violations) ?? DEFAULTS.requestTimeoutMs,
    chatTimeoutMs: positiveInt(config.chatTimeoutMs, 'chatTimeoutMs', violations) ?? DEFAULTS.chatTimeoutMs,
    resourceUrls: resourceUrls === 'public' ? 'public' : 'handle',
    toolPrefix,
    enforce: enforce === undefined ? DEFAULTS.enforce : enforce,
    injectEvidence: injectEvidence === undefined ? DEFAULTS.injectEvidence : injectEvidence,
    perKbIsolation: perKbIsolation === undefined ? DEFAULTS.perKbIsolation : perKbIsolation,
    policyOrder: policyOrder === undefined ? DEFAULTS.policyOrder : policyOrder,
    minQueryChars: minQueryChars ?? DEFAULTS.minQueryChars,
    minCoverage: minCoverage === undefined ? DEFAULTS.minCoverage : minCoverage,
    minScore,
    maxInjectedChars: maxInjectedChars ?? DEFAULTS.maxInjectedChars,
    injectTopK: injectTopK ?? DEFAULTS.injectTopK,
    temperatureCap,
    tenantId,
    extraHeaders,
    maxRetries: maxRetries === undefined ? DEFAULTS.maxRetries : maxRetries,
    maxWikiChars: maxWikiChars ?? DEFAULTS.maxWikiChars,
  };
  if (violations.length > 0) throw new ConfigError(violations);
  return resolved;
}
