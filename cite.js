/**
 * Citation parsing and verification.
 *
 * "Cite your sources" is only enforceable if the citation can be checked
 * afterwards, so this module turns an answer into a list of claims and matches
 * each one against the evidence pages this process actually retrieved.
 *
 * Pure by design: the tool layer supplies the pages, tests supply fixtures.
 */

const MARKER = /\[K(\d+)\]/g;
const KNOWLEDGE_ID = /knowledge[_ ]?id\s*[:：=]?\s*([0-9a-fA-F][0-9a-fA-F-]{7,})/g;
const CHUNK_INDEX = /chunk\s*(?:#|序号)?\s*[:：=]?\s*(\d+)/i;

/** @param {string} answer @returns {string[]} unique markers in order, e.g. ['K1','K3'] */
export function parseMarkers(answer) {
  const seen = new Set();
  const out = [];
  for (const match of String(answer ?? '').matchAll(MARKER)) {
    const marker = `K${match[1]}`;
    if (!seen.has(marker)) {
      seen.add(marker);
      out.push(marker);
    }
  }
  return out;
}

/**
 * Extract `knowledge_id … chunk N` pairs written inline instead of as markers.
 *
 * The chunk index is only looked for *after* the id and before the next line
 * break: a citation list like
 *
 *     - knowledge_id: A · chunk 3
 *     - knowledge_id: B
 *
 * must not pair B with A's chunk number, which would make a correct citation
 * fail verification.
 * @param {string} answer
 * @returns {{knowledge_id: string, chunk_index: number|null, raw: string}[]}
 */
export function parseInlineCitations(answer) {
  const text = String(answer ?? '');
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(KNOWLEDGE_ID)) {
    const knowledgeId = match[1].toLowerCase();
    const idEnd = (match.index ?? 0) + match[0].length;
    const lineEnd = text.indexOf('\n', idEnd);
    const restOfLine = text.slice(idEnd, lineEnd === -1 ? text.length : lineEnd);
    const chunkMatch = restOfLine.match(CHUNK_INDEX);
    const chunkIndex = chunkMatch === null ? null : Number(chunkMatch[1]);
    const dedupe = `${knowledgeId}#${chunkIndex ?? '-'}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ knowledge_id: knowledgeId, chunk_index: chunkIndex, raw: match[0].slice(0, 80) });
  }
  return out;
}

function pageHits(pages) {
  const out = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const hit of Array.isArray(page?.hits) ? page.hits : []) out.push({ ...hit, page: page.turn ?? null, source: page.source ?? null });
  }
  return out;
}

/**
 * Verify an answer against the evidence pages retrieved for it.
 *
 * Statuses:
 * - `verified`         the marker / id resolves to a retrieved passage
 * - `unknown_source`   a [K#] marker that no retrieved page contains
 * - `not_in_evidence`  an inline knowledge_id that no retrieved page contains
 * - `malformed`        a citation-shaped fragment that cannot be resolved
 *
 * @param {{answer: string, pages: object[], requireChunk?: boolean}} input
 * @returns {{ok: boolean, total: number, verified: number, unverified: number, citations: object[], notes: string}}
 */
export function verifyCitations(input) {
  const answer = String(input.answer ?? '');
  const requireChunk = input.requireChunk === true;
  const hits = pageHits(input.pages);
  const byMarker = new Map();
  for (const hit of hits) {
    const marker = typeof hit.marker === 'string' ? hit.marker : '';
    if (marker !== '' && !byMarker.has(marker)) byMarker.set(marker, hit);
  }
  const byKnowledge = new Map();
  for (const hit of hits) {
    const key = `${String(hit.knowledge_id ?? '').toLowerCase()}#${hit.chunk_index ?? -1}`;
    if (!byKnowledge.has(key)) byKnowledge.set(key, hit);
  }

  const citations = [];
  for (const marker of parseMarkers(answer)) {
    const hit = byMarker.get(marker);
    if (hit === undefined) {
      citations.push({
        kind: 'marker', marker, status: 'unknown_source',
        knowledge_id: '', chunk_index: -1, document: '',
        detail: `答案引用了 [${marker}]，但本轮检索结果里没有这个编号`,
      });
      continue;
    }
    citations.push({
      kind: 'marker', marker, status: 'verified',
      knowledge_id: hit.knowledge_id ?? '', chunk_index: hit.chunk_index ?? -1, document: hit.document ?? '',
      detail: '与检索片段一致',
    });
  }

  for (const inline of parseInlineCitations(answer)) {
    const candidates = hits.filter((hit) => String(hit.knowledge_id ?? '').toLowerCase() === inline.knowledge_id);
    if (candidates.length === 0) {
      citations.push({
        kind: 'inline', marker: '', status: 'not_in_evidence',
        knowledge_id: inline.knowledge_id, chunk_index: inline.chunk_index ?? -1, document: '',
        detail: '该 knowledge_id 不在本轮检索结果中',
      });
      continue;
    }
    const exact = inline.chunk_index === null
      ? candidates[0]
      : candidates.find((hit) => hit.chunk_index === inline.chunk_index);
    if (exact === undefined) {
      citations.push({
        kind: 'inline', marker: '', status: 'not_in_evidence',
        knowledge_id: inline.knowledge_id, chunk_index: inline.chunk_index ?? -1, document: candidates[0].document ?? '',
        detail: `文档在证据里，但 chunk ${inline.chunk_index} 不在本轮检索结果中`,
      });
      continue;
    }
    if (requireChunk && inline.chunk_index === null) {
      citations.push({
        kind: 'inline', marker: '', status: 'malformed',
        knowledge_id: inline.knowledge_id, chunk_index: -1, document: exact.document ?? '',
        detail: '只给了 knowledge_id，没有 chunk 序号（requireChunk=true）',
      });
      continue;
    }
    citations.push({
      kind: 'inline', marker: '', status: 'verified',
      knowledge_id: exact.knowledge_id ?? '', chunk_index: exact.chunk_index ?? -1, document: exact.document ?? '',
      detail: '与检索片段一致',
    });
  }

  const verified = citations.filter((c) => c.status === 'verified').length;
  const unverified = citations.length - verified;
  const notes = citations.length === 0
    ? '答案里没有找到任何引用（[K#] 或 knowledge_id + chunk）。'
    : (unverified === 0 ? '所有引用都能对上本轮检索片段。' : `${unverified} 条引用无法对上本轮检索片段。`);
  return { ok: citations.length > 0 && unverified === 0, total: citations.length, verified, unverified, citations, notes };
}

/** Human/model readable report for the tool renderer. */
export function renderCitationReport(result) {
  const lines = [
    `引用自检：${result.verified}/${result.total} 通过${result.ok ? ' ✅' : ' ❌'}`,
    result.notes,
  ];
  for (const citation of result.citations) {
    const target = citation.kind === 'marker'
      ? `[${citation.marker}]`
      : `${citation.knowledge_id}${citation.chunk_index >= 0 ? ` · chunk ${citation.chunk_index}` : ''}`;
    lines.push(`- ${target} · ${citation.status}${citation.document ? ` · 《${citation.document}》` : ''} — ${citation.detail}`);
  }
  return lines.join('\n');
}
