/** Tool definitions for the grounding plugin. */

import { annotateHits } from './gate.js'
import { parseMarkers, verifyCitations, renderCitationReport } from './cite.js'

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

/** Zod-free JSON schema subset accepted by dsh-tools for a numeric/null field. */
const RERANK_SCHEMA = {
  type: 'object',
  properties: {
    applied: { type: 'boolean' },
    outcome: { type: 'string' },
    model_id: { type: 'string' },
    model_source: { type: 'string' },
    top_score: { type: 'number' },
    candidate_count: { type: 'integer' },
    result_count: { type: 'integer' },
    error: { type: 'string' },
  },
  required: ['applied', 'outcome'],
  additionalProperties: false,
};

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    min_coverage: { type: 'number' },
    min_score: { type: 'number' },
    top_coverage: { type: 'number' },
    top_score: { type: 'number' },
    candidate_count: { type: 'integer' },
    kept: { type: 'integer' },
    query_terms: { type: 'integer' },
    dropped_by_coverage: { type: 'integer' },
    dropped_by_score: { type: 'integer' },
    dropped_missing_provenance: { type: 'integer' },
  },
  required: [
    'min_coverage', 'top_coverage', 'top_score', 'candidate_count', 'kept', 'query_terms',
    'dropped_by_coverage', 'dropped_by_score', 'dropped_missing_provenance',
  ],
  additionalProperties: false,
};

const HIT_SCHEMA = {
  type: 'object',
  properties: {
    rank: { type: 'integer' },
    marker: { type: 'string' },
    chunk_id: { type: 'string' },
    knowledge_id: { type: 'string' },
    document: { type: 'string' },
    chunk_index: { type: 'integer' },
    score: { type: 'number' },
    coverage: { type: 'number' },
    content: { type: 'string' },
  },
  required: ['rank', 'marker', 'chunk_id', 'knowledge_id', 'document', 'chunk_index', 'score', 'coverage', 'content'],
  additionalProperties: false,
};

const CITATION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['marker', 'inline'] },
    marker: { type: 'string' },
    status: { type: 'string', enum: ['verified', 'unknown_source', 'not_in_evidence', 'malformed'] },
    knowledge_id: { type: 'string' },
    chunk_index: { type: 'integer' },
    document: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['kind', 'marker', 'status', 'knowledge_id', 'chunk_index', 'document', 'detail'],
  additionalProperties: false,
};

function text(value) {
  return [{ type: 'text', text: value }];
}

function clip(value, max) {
  const flat = String(value ?? '');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Gate diagnostics as the tool schema expects them (absent min_score is omitted). */
function gateReport(diagnostics) {
  return {
    min_coverage: diagnostics.min_coverage,
    ...(typeof diagnostics.min_score === 'number' ? { min_score: diagnostics.min_score } : {}),
    top_coverage: diagnostics.top_coverage,
    top_score: diagnostics.top_score,
    candidate_count: diagnostics.candidate_count,
    kept: diagnostics.kept,
    query_terms: diagnostics.query_terms,
    dropped_by_coverage: diagnostics.dropped_by_coverage,
    dropped_by_score: diagnostics.dropped_by_score,
    dropped_missing_provenance: diagnostics.dropped_missing_provenance,
  };
}

/** Agent id attached to a tool execution, used to scope the evidence ledger. */
function agentIdOf(exec) {
  const id = exec?.agent?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function gateSummary(diagnostics) {
  return `candidates=${diagnostics.candidate_count} kept=${diagnostics.kept} `
    + `top_coverage=${diagnostics.top_coverage.toFixed(2)} (min ${diagnostics.min_coverage.toFixed(2)}) `
    + `dropped_coverage=${diagnostics.dropped_by_coverage} dropped_score=${diagnostics.dropped_by_score} `
    + `dropped_unprovable=${diagnostics.dropped_missing_provenance}`;
}

/** Assemble the grounding tool definitions for one configured deployment. */
export function createTools(client, config, options = {}) {
  const ledger = options.ledger;
  const name = (suffix) => `${config.toolPrefix}_${suffix}`;
  const scopeNote = config.knowledgeBaseIds.length > 0
    ? ` Defaults to knowledge base(s) ${config.knowledgeBaseIds.join(', ')}.`
    : ' Defaults to every knowledge base this credential can see.';

  const definitions = [];

  definitions.push({
    name: name('search'),
    description: 'MANDATORY first step for any question about organizational knowledge: retrieve verbatim passages '
      + 'from WeKnora (hybrid vector + keyword recall, reranked by default). Answer only from what this returns and '
      + 'cite the passages. A passage is only evidence when it passes the coverage gate; an empty or insufficient '
      + 'result means the knowledge base has no evidence — say so instead of guessing.'
      + scopeNote,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query; a full question retrieves better than keywords.' },
        knowledge_base_ids: { ...STRING_ARRAY, description: 'Restrict the search to these knowledge base ids.' },
        knowledge_ids: { ...STRING_ARRAY, description: 'Restrict the search to these document ids.' },
        max_results: { type: 'integer', description: `Maximum passages to return (default ${config.maxResults}).` },
        rerank: { type: 'boolean', description: 'Force the rerank stage on or off for this call; omitted keeps the deployment default.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          knowledge_base_ids: STRING_ARRAY,
          count: { type: 'integer' },
          insufficient: { type: 'boolean' },
          gate: GATE_SCHEMA,
          rerank: RERANK_SCHEMA,
          results: { type: 'array', items: HIT_SCHEMA },
        },
        required: ['query', 'knowledge_base_ids', 'count', 'insufficient', 'gate', 'results'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.insufficient) {
          return text(`No passage passed the evidence gate for "${value.query}". `
            + `Report insufficient evidence; do not answer from memory.\n(${gateSummary(value.gate)})`);
        }
        const lines = value.results.map((hit) =>
          `[${hit.marker}] ${hit.document} · chunk ${hit.chunk_index} · score ${hit.score.toFixed(4)} · coverage ${hit.coverage.toFixed(2)} · knowledge_id ${hit.knowledge_id}\n    ${hit.content}`);
        const rerank = value.rerank
          ? `\nrerank: applied=${value.rerank.applied} outcome=${value.rerank.outcome} model=${value.rerank.model_id ?? '-'} top_score=${value.rerank.top_score ?? '-'}`
          : '';
        return text(`${value.count} passage(s) for "${value.query}":\n${lines.join('\n')}\n(${gateSummary(value.gate)})${rerank}`);
      },
    },
    async execute(args, exec) {
      const requested = Array.isArray(args.knowledge_base_ids) ? args.knowledge_base_ids.filter((x) => typeof x === 'string') : [];
      const knowledgeIds = Array.isArray(args.knowledge_ids) ? args.knowledge_ids.filter((x) => typeof x === 'string') : [];
      const scope = requested.length > 0 ? requested : config.knowledgeBaseIds;
      const maxResults = typeof args.max_results === 'number' ? args.max_results : config.maxResults;
      const { results, rerank } = await client.search({
        query: String(args.query),
        knowledgeBaseIds: scope,
        knowledgeIds,
        matchCount: maxResults,
        rerank: typeof args.rerank === 'boolean' ? { enabled: args.rerank } : undefined,
      }, exec.signal);
      const { hits, insufficient, diagnostics } = annotateHits(results, {
        query: String(args.query),
        minCoverage: config.minCoverage,
        minScore: config.minScore,
        maxResults,
      });
      const marked = hits.map((hit, index) => ({ ...hit, marker: `K${index + 1}` }));
      ledger?.record({
        source: 'search',
        turn: null,
        query: String(args.query),
        hits: marked,
        diagnostics,
        agentId: agentIdOf(exec),
      });
      return {
        query: String(args.query),
        knowledge_base_ids: scope,
        count: marked.length,
        insufficient,
        gate: gateReport(diagnostics),
        // Omitted rather than null: the declared schema allows "absent", not null.
        ...(rerank ? { rerank } : {}),
        results: marked.map((hit, index) => ({
          rank: index + 1,
          marker: hit.marker,
          chunk_id: hit.chunk_id,
          knowledge_id: hit.knowledge_id,
          document: hit.document,
          chunk_index: hit.chunk_index,
          score: hit.score,
          coverage: hit.coverage,
          content: clip(hit.content, config.maxChunkChars),
        })),
      };
    },
  });

  definitions.push({
    name: name('read'),
    description: `Read one WeKnora document's stored passages in order, reassembled into text. Use after ${name('search')} `
      + 'when a single passage is not enough context; page through long documents.',
    parameters: {
      type: 'object',
      properties: {
        knowledge_id: { type: 'string', description: 'Document id, as returned in a search hit.' },
        page: { type: 'integer', description: 'Page of passages, starting at 1.' },
        page_size: { type: 'integer', description: 'Passages per page (max 100).' },
      },
      required: ['knowledge_id'],
      additionalProperties: false,
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          knowledge_id: { type: 'string' },
          page: { type: 'integer' },
          page_size: { type: 'integer' },
          total_chunks: { type: 'integer' },
          returned_chunks: { type: 'integer' },
          has_more: { type: 'boolean' },
          content: { type: 'string' },
        },
        required: ['knowledge_id', 'page', 'page_size', 'total_chunks', 'returned_chunks', 'has_more', 'content'],
        additionalProperties: false,
      },
      render: (_args, value) => text(value.returned_chunks === 0
        ? `Document ${value.knowledge_id} has no passage on page ${value.page}.`
        : `Document ${value.knowledge_id}, passages ${value.returned_chunks} of ${value.total_chunks} (page ${value.page}):\n${value.content}`),
    },
    async execute(args, exec) {
      const knowledgeId = String(args.knowledge_id);
      const page = typeof args.page === 'number' ? Math.max(1, Math.floor(args.page)) : 1;
      const pageSize = typeof args.page_size === 'number' ? Math.min(100, Math.max(1, Math.floor(args.page_size))) : 20;
      const { chunks, total } = await client.readChunks({ knowledgeId, page, pageSize }, exec.signal);
      const ordered = [...chunks].sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
      const joined = ordered.map((chunk) => (typeof chunk.content === 'string' ? chunk.content : '')).join('\n\n');
      return {
        knowledge_id: knowledgeId,
        page,
        page_size: pageSize,
        total_chunks: total,
        returned_chunks: ordered.length,
        has_more: (page - 1) * pageSize + ordered.length < total,
        content: clip(joined, config.maxChunkChars * Math.max(1, Math.min(ordered.length, 10))),
      };
    },
  });

  definitions.push({
    name: name('ask'),
    description: `Ask WeKnora to compose its own cited answer (server-side retrieval + rerank + summarization). `
      + `Prefer ${name('search')} when you can reason over passages yourself; use this for synthesis questions that span `
      + 'many documents. Note: on the ReAct pipeline (agent_id) WeKnora streams no references event, so citations then '
      + 'exist only as inline <kb> markers inside the answer.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question to answer.' },
        knowledge_base_ids: { ...STRING_ARRAY, description: 'Restrict retrieval to these knowledge base ids.' },
        agent_id: { type: 'string', description: 'WeKnora custom agent id; selects the server-side ReAct pipeline.' },
        session_id: { type: 'string', description: 'Continue an earlier WeKnora session instead of starting one.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    timeoutMs: config.chatTimeoutMs,
    output: {
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          session_id: { type: 'string' },
          pipeline: { type: 'string', enum: ['rag', 'agent'] },
          tool_calls: STRING_ARRAY,
          references: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                knowledge_id: { type: 'string' },
                document: { type: 'string' },
                chunk_index: { type: 'integer' },
                content: { type: 'string' },
              },
              required: ['knowledge_id', 'document', 'chunk_index', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['answer', 'session_id', 'pipeline', 'tool_calls', 'references'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const parts = [value.answer === '' ? 'WeKnora returned an empty answer.' : value.answer];
        if (value.references.length > 0) {
          parts.push(`Citations:\n${value.references.map((ref, i) => `[${i + 1}] ${ref.document} · chunk ${ref.chunk_index} · knowledge_id: ${ref.knowledge_id}`).join('\n')}`);
        }
        if (value.tool_calls.length > 0) parts.push(`WeKnora tools used: ${value.tool_calls.join(', ')}`);
        parts.push(`pipeline: ${value.pipeline} · WeKnora session: ${value.session_id}`);
        return text(parts.join('\n\n'));
      },
    },
    async execute(args, exec) {
      const requested = Array.isArray(args.knowledge_base_ids) ? args.knowledge_base_ids.filter((x) => typeof x === 'string') : [];
      const agentId = typeof args.agent_id === 'string' && args.agent_id !== '' ? args.agent_id : config.agentId;
      // An agent route still honours the configured scope: omitting the ids
      // would let the server answer from every knowledge base the credential
      // can see, which is wider than what the profile asked for.
      const knowledgeBaseIds = requested.length > 0 ? requested : config.knowledgeBaseIds;
      const sessionId = typeof args.session_id === 'string' && args.session_id !== ''
        ? args.session_id
        : await client.createSession(`dsh-ground: ${clip(args.query, 60)}`, exec.signal);
      const streamed = await client.ask({ sessionId, query: String(args.query), knowledgeBaseIds, agentId }, exec.signal);
      const references = streamed.references.slice(0, config.maxResults).map((ref, index) => ({
        knowledge_id: typeof ref.knowledge_id === 'string' ? ref.knowledge_id : '',
        document: typeof ref.knowledge_title === 'string' && ref.knowledge_title !== ''
          ? ref.knowledge_title
          : (typeof ref.knowledge_filename === 'string' ? ref.knowledge_filename : ''),
        chunk_index: typeof ref.chunk_index === 'number' ? ref.chunk_index : -1,
        content: clip(ref.content, config.maxChunkChars),
        marker: `K${index + 1}`,
      }));
      if (references.length > 0) {
        ledger?.record({
          source: 'ask',
          turn: null,
          query: String(args.query),
          hits: references,
          agentId: agentIdOf(exec),
        });
      }
      return {
        answer: streamed.answer.trim(),
        session_id: sessionId,
        pipeline: agentId === undefined ? 'rag' : 'agent',
        tool_calls: streamed.toolCalls,
        references: references.map(({ marker: _marker, ...rest }) => rest),
      };
    },
  });

  definitions.push({
    name: name('check_citations'),
    description: 'Verify the citations in a draft answer against the evidence this process actually retrieved '
      + '(pre-step injection, search results and ask references). Every [K#] marker and every inline '
      + 'knowledge_id (+ chunk) is checked; the result says which citations cannot be traced back. '
      + 'Use it before delivering an answer that cites the knowledge base.',
    parameters: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The draft answer, as it will be shown to the user.' },
        require_chunk: { type: 'boolean', description: 'When true, an inline knowledge_id without a chunk index counts as malformed.' },
      },
      required: ['answer'],
      additionalProperties: false,
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'integer' },
          verified: { type: 'integer' },
          unverified: { type: 'integer' },
          notes: { type: 'string' },
          citations: { type: 'array', items: CITATION_SCHEMA },
        },
        required: ['ok', 'total', 'verified', 'unverified', 'notes', 'citations'],
        additionalProperties: false,
      },
      render: (_args, value) => text(renderCitationReport(value)),
    },
    async execute(args, exec) {
      const agentId = agentIdOf(exec);
      // Verify against this agent's own evidence only: a [K1] from another
      // session must not verify, and its document title must not leak here.
      const scoped = ledger === undefined
        ? []
        : (agentId === undefined ? (ledger.latest() ? [ledger.latest()] : []) : ledger.pagesFor(agentId));
      const pages = scoped.slice().reverse();
      const result = verifyCitations({
        answer: String(args.answer ?? ''),
        pages,
        requireChunk: args.require_chunk === true,
      });
      return {
        ok: result.ok,
        total: result.total,
        verified: result.verified,
        unverified: result.unverified,
        notes: pages.length === 0
          ? `${result.notes}（本进程还没有记录任何证据页；先执行一次检索。）`
          : result.notes,
        citations: result.citations,
      };
    },
  });

  definitions.push({
    name: name('list_knowledge_bases'),
    description: 'List the WeKnora knowledge bases this credential can see, with id, name and document count. '
      + 'Use it to discover which ids to pass to the other tools, or to answer "what knowledge bases exist".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive substring filter on name or id.' },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          knowledge_bases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                chunk_count: { type: 'integer' },
              },
              required: ['id', 'name', 'description', 'chunk_count'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'knowledge_bases'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.count === 0) return text('No knowledge base is visible to this credential.');
        const lines = value.knowledge_bases.map((kb) =>
          `- ${kb.id} · ${kb.name} · ${kb.chunk_count} chunk(s)${kb.description ? ` — ${kb.description}` : ''}`);
        return text(`${value.count} knowledge base(s):\n${lines.join('\n')}`);
      },
    },
    async execute(args, exec) {
      const all = await client.listKnowledgeBases(exec.signal);
      const filter = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const items = all.map((kb) => ({
        id: typeof kb.id === 'string' ? kb.id : '',
        name: typeof kb.name === 'string' ? kb.name : '',
        description: typeof kb.description === 'string' ? kb.description : '',
        chunk_count: typeof kb.chunk_count === 'number' && Number.isFinite(kb.chunk_count) ? Math.floor(kb.chunk_count) : 0,
      })).filter((kb) => filter === ''
        || kb.name.toLowerCase().includes(filter)
        || kb.id.toLowerCase().includes(filter));
      return { count: items.length, knowledge_bases: items };
    },
  });

  definitions.push({
    name: name('wiki_search'),
    description: 'Search WeKnora Wiki pages — the topic/entity pages generated from the knowledge base — by title, '
      + 'slug, alias, summary or content (case-insensitive substring matching). Use it for "what does the knowledge '
      + `base say about X" questions, then ${name('wiki_read')} to read the whole page.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Title / slug / alias / content text to look for.' },
        knowledge_base_ids: { ...STRING_ARRAY, description: 'Restrict the search to these knowledge base ids.' },
        limit: { type: 'integer', description: 'Maximum pages per knowledge base (default 10).' },
        regex: { type: 'boolean', description: 'Set false to force literal matching (default: server behaviour, regex).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                knowledge_base_id: { type: 'string' },
                slug: { type: 'string' },
                title: { type: 'string' },
                page_type: { type: 'string' },
                status: { type: 'string' },
                summary: { type: 'string' },
                snippet: { type: 'string' },
                source_refs_count: { type: 'integer' },
              },
              required: ['knowledge_base_id', 'slug', 'title', 'page_type', 'status', 'summary', 'snippet', 'source_refs_count'],
              additionalProperties: false,
            },
          },
          failures: {
            type: 'array',
            items: {
              type: 'object',
              properties: { kb_id: { type: 'string' }, error: { type: 'string' } },
              required: ['kb_id', 'error'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'pages', 'failures'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const parts = [];
        if (value.count === 0) {
          parts.push(`No wiki page matched "${String(_args.query ?? '')}".`);
        } else {
          const lines = value.pages.map((page) =>
            `- [${page.page_type}] ${page.slug} · ${page.title} — ${page.summary || page.snippet}`);
          parts.push(`${value.count} wiki page(s) for "${String(_args.query ?? '')}":\n${lines.join('\n')}`);
          parts.push(`Read a whole page with ${name('wiki_read')} and its slug.`);
        }
        if (value.failures.length > 0) {
          parts.push(`Retrieval failed for: ${value.failures.map((f) => `${f.kb_id}: ${f.error}`).join('; ')}`);
        }
        return text(parts.join('\n\n'));
      },
    },
    async execute(args, exec) {
      const requested = Array.isArray(args.knowledge_base_ids) ? args.knowledge_base_ids.filter((x) => typeof x === 'string') : [];
      const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 10;
      let scope = requested.length > 0 ? requested : config.knowledgeBaseIds;
      if (scope.length === 0) {
        // No configured scope: search every knowledge base this credential can see.
        const visible = await client.listKnowledgeBases(exec.signal);
        scope = visible.map((kb) => kb.id).filter((id) => typeof id === 'string' && id !== '').slice(0, 10);
        if (scope.length === 0) throw new Error('no knowledge base is visible to this credential');
      }
      const settled = await Promise.allSettled(scope.map((kbId) => client.wikiSearch({
        kbId,
        query: String(args.query),
        limit,
        regex: typeof args.regex === 'boolean' ? args.regex : undefined,
      }, exec.signal)));
      const pages = [];
      const failures = [];
      settled.forEach((outcome, index) => {
        if (outcome.status === 'rejected') {
          failures.push({ kb_id: scope[index], error: String(outcome.reason?.message ?? outcome.reason).slice(0, 200) });
          return;
        }
        for (const page of outcome.value.pages) {
          pages.push({
            knowledge_base_id: scope[index],
            slug: typeof page.slug === 'string' ? page.slug : '',
            title: typeof page.title === 'string' ? page.title : '',
            page_type: typeof page.page_type === 'string' ? page.page_type : '',
            status: typeof page.status === 'string' ? page.status : '',
            summary: clip(page.summary, 300),
            snippet: clip(String(page.content ?? '').replace(/\s+/g, ' '), 400),
            source_refs_count: Array.isArray(page.source_refs) ? page.source_refs.length : 0,
          });
        }
      });
      return { count: pages.length, pages, failures };
    },
  });

  definitions.push({
    name: name('wiki_read'),
    description: `Read one WeKnora Wiki page by slug (for example concept/inspection-cycle). Use after ${name('wiki_search')} `
      + 'when the summary is not enough; the page carries its own source document references.',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Wiki page slug, as returned by wiki_search.' },
        knowledge_base_id: { type: 'string', description: 'Knowledge base id; required when more than one is configured.' },
        max_chars: { type: 'integer', description: `Maximum characters of page content to return (default ${config.maxWikiChars}).` },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          knowledge_base_id: { type: 'string' },
          slug: { type: 'string' },
          title: { type: 'string' },
          page_type: { type: 'string' },
          status: { type: 'string' },
          version: { type: 'integer' },
          summary: { type: 'string' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
          source_refs: STRING_ARRAY,
          in_links: STRING_ARRAY,
          out_links: STRING_ARRAY,
        },
        required: ['knowledge_base_id', 'slug', 'title', 'page_type', 'status', 'version', 'summary', 'content', 'truncated', 'source_refs', 'in_links', 'out_links'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const parts = [
          `[${value.page_type}] ${value.title} (${value.slug}) · status=${value.status} · v${value.version}`
            + (value.knowledge_base_id ? ` · kb=${value.knowledge_base_id}` : ''),
        ];
        if (value.summary !== '') parts.push(`Summary: ${value.summary}`);
        parts.push(value.content === '' ? '(empty page)' : value.content);
        if (value.truncated) parts.push(`(content truncated; ${value.source_refs.length} source reference(s) — read the source document with ${name('read')})`);
        if (value.source_refs.length > 0) parts.push(`Sources: ${value.source_refs.join(', ')}`);
        return text(parts.join('\n\n'));
      },
    },
    async execute(args, exec) {
      const requested = typeof args.knowledge_base_id === 'string' && args.knowledge_base_id !== ''
        ? args.knowledge_base_id
        : (config.knowledgeBaseIds.length === 1 ? config.knowledgeBaseIds[0] : '');
      let kbId = requested;
      if (kbId === '') {
        const visible = await client.listKnowledgeBases(exec.signal);
        const ids = visible.map((kb) => kb.id).filter((id) => typeof id === 'string' && id !== '');
        if (ids.length === 0) throw new Error('no knowledge base is visible to this credential');
        kbId = ids[0];
      }
      const page = await client.wikiRead({ kbId, slug: String(args.slug) }, exec.signal);
      const maxChars = typeof args.max_chars === 'number'
        ? Math.max(200, Math.floor(args.max_chars))
        : config.maxWikiChars;
      const fullContent = typeof page.content === 'string' ? page.content : '';
      const content = clip(fullContent, maxChars);
      const strings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);
      return {
        knowledge_base_id: kbId,
        slug: typeof page.slug === 'string' ? page.slug : String(args.slug),
        title: typeof page.title === 'string' ? page.title : '',
        page_type: typeof page.page_type === 'string' ? page.page_type : '',
        status: typeof page.status === 'string' ? page.status : '',
        version: typeof page.version === 'number' && Number.isFinite(page.version) ? Math.floor(page.version) : 0,
        summary: typeof page.summary === 'string' ? page.summary : '',
        content,
        truncated: content.length < fullContent.length,
        source_refs: strings(page.source_refs),
        in_links: strings(page.in_links),
        out_links: strings(page.out_links),
      };
    },
  });

  return definitions;
}

export { parseMarkers };
