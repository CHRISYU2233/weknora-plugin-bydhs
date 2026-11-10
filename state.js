/**
 * Process-local state shared between the tool layer and the pre-step injection.
 *
 * Two jobs:
 * - remember the evidence pages this process retrieved, so an answer's
 *   citations can be checked against what the model was actually shown;
 * - remember which user message already received an injection, so a multi-step
 *   turn does not inject the same evidence again on every step.
 *
 * Nothing here is persisted: a restarted host starts with an empty ledger, and
 * `wkg_check_citations` then reports citations as unknown rather than guessing.
 */

function clip(value, max) {
  const flat = String(value ?? '');
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Bounded ring of evidence pages, newest last. Pages are tagged with the agent
 * they were retrieved for, so one session's citations never verify against
 * another session's evidence.
 * @param {{maxPages?: number, maxContentChars?: number}} [options]
 */
export function createEvidenceLedger(options = {}) {
  const maxPages = typeof options.maxPages === 'number' && options.maxPages > 0 ? options.maxPages : 8;
  const maxContentChars = typeof options.maxContentChars === 'number' && options.maxContentChars > 0
    ? options.maxContentChars
    : 1500;
  const pages = [];
  return {
    /** @param {{agentId?: string, source: string, turn?: number|null, query: string, hits: object[]}} page */
    record(page) {
      const hits = (Array.isArray(page.hits) ? page.hits : []).map((hit) => ({
        ...hit,
        content: clip(hit.content, maxContentChars),
      }));
      const entry = { ...page, hits, recordedAt: Date.now() };
      pages.push(entry);
      while (pages.length > maxPages) pages.shift();
      return entry;
    },
    /** All pages, oldest first. */
    pages() {
      return pages.slice();
    },
    /** Pages recorded for one agent (all pages when the id is unknown). */
    pagesFor(agentId) {
      if (typeof agentId !== 'string' || agentId === '') return pages.slice();
      return pages.filter((page) => page.agentId === agentId);
    },
    /** Newest page, or undefined. */
    latest() {
      return pages.length > 0 ? pages[pages.length - 1] : undefined;
    },
    /** Newest page for one agent, or undefined. */
    latestFor(agentId) {
      if (typeof agentId !== 'string' || agentId === '') return this.latest();
      for (let i = pages.length - 1; i >= 0; i -= 1) {
        if (pages[i].agentId === agentId) return pages[i];
      }
      return undefined;
    },
    clear() {
      pages.length = 0;
    },
    size() {
      return pages.length;
    },
  };
}

/**
 * Dedupe tracker for `agent/pre-step`.
 *
 * The token is the id of the user message the evidence was injected into. A
 * mid-turn `steer` message carries a new id and is therefore grounded too,
 * while the later steps of the same turn (which claim no new user message) are
 * not grounded again. Keying on the message id rather than the turn number also
 * survives a same-process session reload, whose turn counter restarts at 1.
 */
export function createTurnTracker(options = {}) {
  const maxKeys = typeof options.maxKeys === 'number' && options.maxKeys > 0 ? options.maxKeys : 512;
  const byAgent = new WeakMap();
  const byKey = new Map();
  return {
    /**
     * @param {{agent?: object, key?: string}} identity
     * @param {string} token
     * @returns {boolean} true when this exact message was already grounded
     */
    seen(identity, token) {
      if (identity.agent && byAgent.get(identity.agent) === token) return true;
      return identity.key ? byKey.get(identity.key) === token : false;
    },
    mark(identity, token) {
      if (identity.agent) byAgent.set(identity.agent, token);
      if (identity.key) {
        byKey.delete(identity.key);
        byKey.set(identity.key, token);
        while (byKey.size > maxKeys) {
          const oldest = byKey.keys().next().value;
          byKey.delete(oldest);
        }
      }
    },
    clear() {
      byKey.clear();
    },
  };
}

/**
 * Sessions/agents that were grounded at least once. Used to cap sampling
 * temperature for the rest of the session, and cleared on unload.
 */
export function createGroundedSet(options = {}) {
  const maxKeys = typeof options.maxKeys === 'number' && options.maxKeys > 0 ? options.maxKeys : 512;
  const agents = new WeakSet();
  const keys = new Set();
  return {
    add(identity) {
      if (identity.agent) agents.add(identity.agent);
      if (identity.key) {
        keys.delete(identity.key);
        keys.add(identity.key);
        while (keys.size > maxKeys) {
          const oldest = keys.values().next().value;
          keys.delete(oldest);
        }
      }
    },
    has(identity) {
      if (identity.agent && agents.has(identity.agent)) return true;
      return identity.key ? keys.has(identity.key) : false;
    },
    clear() {
      keys.clear();
    },
  };
}
