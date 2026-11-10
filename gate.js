/**
 * Deterministic evidence gate.
 *
 * WeKnora returns a ranked list for every query, including queries it has no
 * evidence for: the vector search always finds *something*. Handing those
 * passages to the model is how "grounded" answers quietly become guesses, so
 * this module decides, from signals we can compute ourselves, whether a passage
 * counts as evidence at all.
 *
 * The primary signal is lexical coverage of the query by the passage — a ratio
 * in [0, 1] that does not depend on the deployment's score scale (cosine,
 * rerank logit, BM25, ...). An optional absolute score floor is available for
 * deployments whose search returns normalised 0..1 scores.
 */

const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const CJK_CHAR = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN_WORD = /[a-z0-9][a-z0-9_+#.-]{1,}/g;

/** Function characters that carry no retrieval signal in a question. */
const STOP_CHARS = /[的了吗呢啊呀吧嘛哦嗯是]/g;
/** Whole question words that would otherwise dominate the coverage ratio. */
const STOP_WORDS = /(多少|什么|怎么|怎样|如何|为什么|哪些|哪个|是否|可以|能不能|请问|一下|我们|你们|他们|这个|那个|有没有)/g;

const GREETING = /^(你好|您好|hi|hello|hey|在吗|谢谢|thanks|thank you|ok|好的|收到|早上好|晚上好)[\s!！。,.，?？~～]*$/i;
const META = /^(你是谁|你叫什么|你能做什么|你会什么|help|who are you|what can you do)/i;
const SHELL = /```|^\s*(npm|pnpm|yarn|git|node|python|pip|curl|docker|kubectl|cd|ls|dir|pwsh|powershell|bash)\b/i;
const QUESTION = /[?？]|吗|呢|什么|啥|如何|怎么|怎样|为什么|多少|哪|谁|何时|是否|能不能|可不可以|是不是|有没有|会不会|how|what|why|when|where|which|who|does|is it|are there/i;

/**
 * Query terms used for coverage: lowercased latin words plus CJK unigrams and
 * bigrams, after dropping question words and function characters. Bigrams keep
 * Chinese coverage meaningful without a segmenter; the stop list keeps "是多少"
 * from diluting an otherwise on-topic query.
 * @param {string} text
 * @returns {string[]}
 */
export function queryTerms(text) {
  const lower = String(text ?? '').toLowerCase().replace(STOP_WORDS, ' ').replace(STOP_CHARS, '');
  const terms = new Set();
  for (const word of lower.match(LATIN_WORD) ?? []) terms.add(word);
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

/**
 * Fraction of the query's terms that occur in the passage.
 * @param {string[]} terms
 * @param {string} content
 * @returns {number} 0..1
 */
export function coverageOf(terms, content) {
  if (terms.length === 0) return 1;
  const haystack = String(content ?? '').toLowerCase();
  let hit = 0;
  for (const term of terms) if (haystack.includes(term)) hit += 1;
  return hit / terms.length;
}

/**
 * Decide whether a user message is a question about organizational knowledge
 * that must be grounded. Chit-chat, meta questions about the assistant itself
 * and shell/code syntax are exempt; questions and longer statements are not.
 * @param {string} query
 * @param {{minQueryChars?: number}} config
 * @returns {boolean}
 */
export function shouldGround(query, config = {}) {
  const text = String(query ?? '').trim();
  const min = typeof config.minQueryChars === 'number' ? config.minQueryChars : 8;
  if (text === '' || text.length < min) return false;
  if (GREETING.test(text)) return false;
  if (META.test(text) && text.length < 30) return false;
  if (SHELL.test(text)) return false;
  if (QUESTION.test(text)) return true;
  return text.length >= Math.max(min, 12);
}

function toFiniteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Normalise one WeKnora hit, or return null when it cannot be cited.
 * A passage without `knowledge_id` and `chunk_index` cannot be verified later,
 * so it is not evidence — that is what makes `wkg_check_citations` meaningful.
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeHit(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const knowledgeId = typeof raw.knowledge_id === 'string' ? raw.knowledge_id.trim() : '';
  const chunkIndex = typeof raw.chunk_index === 'number' && Number.isInteger(raw.chunk_index) && raw.chunk_index >= 0
    ? raw.chunk_index
    : -1;
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (knowledgeId === '' || chunkIndex < 0 || content === '') return null;
  return {
    knowledge_id: knowledgeId,
    chunk_id: typeof raw.id === 'string' ? raw.id : '',
    chunk_index: chunkIndex,
    document: typeof raw.knowledge_title === 'string' && raw.knowledge_title !== ''
      ? raw.knowledge_title
      : (typeof raw.knowledge_filename === 'string' ? raw.knowledge_filename : ''),
    score: round(toFiniteNumber(raw.score)),
    content,
  };
}

/**
 * Score, filter and order the hits for one query.
 * @param {object[]} hits raw WeKnora hits
 * @param {{query: string, minCoverage?: number, minScore?: number, maxResults?: number}} options
 * @returns {{hits: object[], insufficient: boolean, diagnostics: object}}
 */
export function annotateHits(hits, options) {
  const query = String(options.query ?? '');
  const minCoverage = typeof options.minCoverage === 'number' ? options.minCoverage : 0.34;
  const minScore = typeof options.minScore === 'number' ? options.minScore : undefined;
  const maxResults = typeof options.maxResults === 'number' ? options.maxResults : 6;
  const terms = queryTerms(query);
  const diagnostics = {
    candidate_count: 0,
    kept: 0,
    dropped_missing_provenance: 0,
    dropped_by_coverage: 0,
    dropped_by_score: 0,
    query_terms: terms.length,
    min_coverage: minCoverage,
    min_score: minScore === undefined ? null : minScore,
    top_coverage: 0,
    top_score: 0,
  };
  const kept = [];
  for (const raw of Array.isArray(hits) ? hits : []) {
    diagnostics.candidate_count += 1;
    const hit = normalizeHit(raw);
    if (hit === null) {
      diagnostics.dropped_missing_provenance += 1;
      continue;
    }
    hit.coverage = round(coverageOf(terms, hit.content));
    diagnostics.top_coverage = Math.max(diagnostics.top_coverage, hit.coverage);
    diagnostics.top_score = Math.max(diagnostics.top_score, hit.score);
    if (hit.coverage < minCoverage) {
      diagnostics.dropped_by_coverage += 1;
      continue;
    }
    if (minScore !== undefined && hit.score < minScore) {
      diagnostics.dropped_by_score += 1;
      continue;
    }
    kept.push(hit);
  }
  kept.sort((a, b) => b.score - a.score || b.coverage - a.coverage);
  const selected = kept.slice(0, maxResults);
  diagnostics.kept = selected.length;
  return { hits: selected, insufficient: selected.length === 0, diagnostics };
}

/** True when the text contains CJK, used only for diagnostics. */
export function hasCjk(text) {
  return CJK_CHAR.test(String(text ?? ''));
}
