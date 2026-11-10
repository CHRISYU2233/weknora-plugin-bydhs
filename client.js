/** Minimal WeKnora REST client used by the grounding tools. No dependencies. */

export class WeknoraApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WeknoraApiError';
    this.status = status;
  }
}

/**
 * Build an abort signal that trips after `timeoutMs`.
 *
 * Returns the signal plus a `done()` that MUST be called when the request
 * settles: the timer otherwise stays armed for the full timeout, keeping the
 * Node event loop alive after the call finished (and leaking one timer per
 * tool call inside a long-lived Harness host).
 */
function deadline(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  );
  const forward = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', forward);
  };
  return { signal: controller.signal, done };
}

/** Transient failures worth one more attempt. */
function isRetryable(error) {
  if (!(error instanceof WeknoraApiError)) return false;
  if (error.status === undefined) return true; // network error / reset / DNS
  return error.status === 429 || error.status === 500 || error.status === 502
    || error.status === 503 || error.status === 504;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('the call was cancelled', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('the call was cancelled', 'AbortError'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export class WeknoraClient {
  constructor(config) {
    this.config = config;
  }

  url(path) {
    return `${this.config.baseUrl}${path}`;
  }

  headers() {
    const headers = {};
    if (this.config.apiKey !== undefined && this.config.apiKey !== '') headers['X-API-Key'] = this.config.apiKey;
    // Platform-scoped keys need to name the workspace; project-scoped keys do not.
    if (this.config.tenantId !== undefined && this.config.tenantId !== '') headers['X-Tenant-ID'] = this.config.tenantId;
    for (const [name, value] of Object.entries(this.config.extraHeaders ?? {})) headers[name] = value;
    return headers;
  }

  /** One logical request, retried on transient failures (429/5xx/network). */
  async fetchJson(path, init = {}, signal) {
    const attempts = Math.max(1, (this.config.maxRetries ?? 1) + 1);
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.requestOnce(path, init, signal);
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt + 1 >= attempts || !isRetryable(error)) throw error;
        await sleep(200 * (attempt + 1), signal);
      }
    }
    throw lastError;
  }

  async requestOnce(path, init = {}, signal) {
    const method = init.method ?? 'GET';
    const limit = deadline(signal, this.config.requestTimeoutMs);
    try {
      let response;
      try {
        response = await fetch(this.url(path), {
          ...init,
          headers: { ...this.headers(), Accept: 'application/json', ...(init.headers ?? {}) },
          signal: limit.signal,
        });
      } catch (cause) {
        throw new WeknoraApiError(`${method} ${path} failed: ${describe(cause, signal)}`);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new WeknoraApiError(`${method} ${path} failed with HTTP ${response.status}: ${reason(text)}`, response.status);
      }
      const body = await response.json().catch(() => null);
      if (body === null) throw new WeknoraApiError(`${method} ${path} returned a non-JSON body`, response.status);
      return body;
    } finally {
      limit.done();
    }
  }

  /** Knowledge bases visible to this credential. */
  async listKnowledgeBases(signal) {
    const envelope = await this.fetchJson('/knowledge-bases', { method: 'GET' }, signal);
    return Array.isArray(envelope.data) ? envelope.data : [];
  }

  /**
   * Hybrid retrieval. `rerank` is passed through verbatim so callers can force
   * it on or off per request; omitted means the deployment default.
   */
  async search(input, signal) {
    const body = {
      query: input.query,
      ...(input.knowledgeBaseIds?.length ? { knowledge_base_ids: input.knowledgeBaseIds } : {}),
      ...(input.knowledgeIds?.length ? { knowledge_ids: input.knowledgeIds } : {}),
      match_count: input.matchCount ?? this.config.maxResults,
      ...(input.rerank ? { rerank: input.rerank } : {}),
    };
    const envelope = await this.fetchJson('/knowledge-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, signal);
    return {
      results: Array.isArray(envelope.data) ? envelope.data : [],
      rerank: projectRerank((envelope.meta ?? {}).rerank),
    };
  }

  /** One page of a document's stored chunks, in storage order. */
  async readChunks(input, signal) {
    const query = new URLSearchParams({ page: String(input.page ?? 1), page_size: String(input.pageSize ?? 20) });
    const envelope = await this.fetchJson(`/chunks/${encodeURIComponent(input.knowledgeId)}?${query}`, { method: 'GET' }, signal);
    const chunks = Array.isArray(envelope.data) ? envelope.data : [];
    return { chunks, total: typeof envelope.total === 'number' ? envelope.total : chunks.length };
  }

  /** Wiki pages of one knowledge base, newest relevance first (server side). */
  async wikiSearch(input, signal) {
    const params = new URLSearchParams({
      q: input.query,
      limit: String(input.limit ?? 10),
    });
    // The server treats `q` as a POSIX regex unless regex=false.
    if (input.regex === false) params.set('regex', 'false');
    const envelope = await this.fetchJson(
      `/knowledgebase/${encodeURIComponent(input.kbId)}/wiki/search?${params}`,
      { method: 'GET' },
      signal,
    );
    const pages = Array.isArray(envelope.pages) ? envelope.pages : [];
    return { pages, total: typeof envelope.total === 'number' ? envelope.total : pages.length };
  }

  /** One wiki page by slug. Slugs look like `concept/some-name`. */
  async wikiRead(input, signal) {
    const slugPath = String(input.slug ?? '')
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const envelope = await this.fetchJson(
      `/knowledgebase/${encodeURIComponent(input.kbId)}/wiki/pages/${slugPath}`,
      { method: 'GET' },
      signal,
    );
    return envelope?.data ?? envelope ?? {};
  }

  async createSession(title, signal) {
    const envelope = await this.fetchJson('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }, signal);
    const id = envelope.data?.id;
    if (typeof id !== 'string' || id === '') throw new WeknoraApiError('POST /sessions returned no session id');
    return id;
  }

  /** RAG or ReAct answer with citations, assembled from the SSE stream. */
  async ask(input, signal) {
    const route = input.agentId === undefined ? 'knowledge-chat' : 'agent-chat';
    const path = `/${route}/${encodeURIComponent(input.sessionId)}`;
    const body = {
      query: input.query,
      channel: 'api',
      ...(input.knowledgeBaseIds?.length ? { knowledge_base_ids: input.knowledgeBaseIds } : {}),
      ...(input.agentId === undefined ? { agent_enabled: false, web_search_enabled: false } : { agent_id: input.agentId, agent_enabled: true }),
    };
    const limit = deadline(signal, this.config.chatTimeoutMs);
    try {
      let response;
      try {
        response = await fetch(this.url(path), {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: limit.signal,
        });
      } catch (cause) {
        throw new WeknoraApiError(`POST ${path} failed: ${describe(cause, signal)}`);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new WeknoraApiError(`POST ${path} failed with HTTP ${response.status}: ${reason(text)}`, response.status);
      }
      if (response.body === null) throw new WeknoraApiError(`POST ${path} returned no response body`);
      return await assembleStream(response.body, path, signal);
    } finally {
      limit.done();
    }
  }
}

function describe(cause, signal) {
  if (cause instanceof Error && cause.name === 'AbortError') return signal?.aborted ? 'the call was cancelled' : 'the request timed out';
  if (cause instanceof Error && cause.name === 'TimeoutError') return 'the request timed out';
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Project WeKnora's rerank diagnostics onto the fields this plugin declares.
 *
 * The tool result schema is strict (`additionalProperties: false`) and results
 * are validated at runtime, so passing the server object through would turn a
 * successful search into a hard tool error on any deployment that adds a field.
 */
function projectRerank(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const projected = {
    applied: raw.applied === true,
    outcome: typeof raw.outcome === 'string' && raw.outcome !== '' ? raw.outcome : 'unknown',
  };
  if (typeof raw.model_id === 'string') projected.model_id = raw.model_id;
  if (typeof raw.model_source === 'string') projected.model_source = raw.model_source;
  if (typeof raw.top_score === 'number' && Number.isFinite(raw.top_score)) projected.top_score = raw.top_score;
  if (typeof raw.candidate_count === 'number' && Number.isFinite(raw.candidate_count)) projected.candidate_count = Math.floor(raw.candidate_count);
  if (typeof raw.result_count === 'number' && Number.isFinite(raw.result_count)) projected.result_count = Math.floor(raw.result_count);
  if (typeof raw.error === 'string') projected.error = raw.error;
  return projected;
}

function reason(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error ?? parsed?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

/** Consume WeKnora's text/event-stream into {answer, references, toolCalls}. */
async function assembleStream(body, path, callerSignal) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const answer = [];
  const toolCalls = [];
  let references = [];
  let completed = false;
  let buffer = '';
  const consumeLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    switch (event.response_type) {
      case 'answer':
        if (typeof event.content === 'string') answer.push(event.content);
        break;
      case 'references':
        if (Array.isArray(event.knowledge_references)) references = event.knowledge_references;
        break;
      case 'tool_call': {
        // This WeKnora build puts the name in data.tool_name; older builds used
        // event.tool_calls[]. Accept both so the field never silently empties.
        const fromData = event.data?.tool_name;
        if (typeof fromData === 'string' && fromData !== '' && !toolCalls.includes(fromData)) toolCalls.push(fromData);
        for (const call of event.tool_calls ?? []) {
          const name = call.function?.name ?? call.name;
          if (typeof name === 'string' && name !== '' && !toolCalls.includes(name)) toolCalls.push(name);
        }
        break;
      }
      case 'error':
        throw new WeknoraApiError(`POST ${path} streamed an error: ${event.content ?? 'unknown error'}`);
      case 'complete':
        completed = true;
        break;
      default:
        break;
    }
  };
  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
        if (completed) break;
        newline = buffer.indexOf('\n');
      }
    }
    if (!completed && buffer !== '') consumeLine(buffer.replace(/\r$/, ''));
  } catch (cause) {
    if (cause instanceof WeknoraApiError) throw cause;
    throw new WeknoraApiError(`POST ${path} stream failed: ${describe(cause, callerSignal)}`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!completed) {
    throw new WeknoraApiError(`POST ${path} ended before WeKnora completed the answer; ${answer.join('').length} character(s) had streamed`);
  }
  return { answer: answer.join(''), references, toolCalls };
}
