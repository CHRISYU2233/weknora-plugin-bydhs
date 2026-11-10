import test from 'node:test'
import assert from 'node:assert/strict'
import { queryTerms, coverageOf, shouldGround, annotateHits, normalizeHit } from '../gate.js'

test('queryTerms covers latin words plus CJK unigrams and bigrams', () => {
  const terms = queryTerms('A-17 设备的点检周期')
  assert.ok(terms.includes('a-17'))
  assert.ok(terms.includes('设备'))
  assert.ok(terms.includes('点检'))
})

test('coverageOf is high for a passage that repeats the query, low otherwise', () => {
  const terms = queryTerms('A-17 设备的点检周期')
  // Stop-character stripping turns "设备的点检" into "设备点检", so a passage that
  // keeps the 的 scores ~0.83 rather than 1.0 — well above the 0.34 gate.
  assert.ok(coverageOf(terms, 'A-17 设备的点检周期为三个月') > 0.8)
  assert.ok(coverageOf(terms, '今天天气很好，适合外出') < 0.2)
})

test('shouldGround skips chit-chat and shell syntax, keeps org questions', () => {
  assert.equal(shouldGround('你好', {}), false)
  assert.equal(shouldGround('好的', {}), false)
  assert.equal(shouldGround('npm 怎么安装依赖', {}), false)
  assert.equal(shouldGround('A-17 设备的点检周期是多少？', {}), true)
  assert.equal(shouldGround('请把 A-17 设备的点检周期整理成表格', {}), true)
})

test('normalizeHit requires citable provenance', () => {
  assert.equal(normalizeHit({ chunk_index: 0, content: 'x' }), null)
  assert.equal(normalizeHit({ knowledge_id: 'k', chunk_index: -1, content: 'x' }), null)
  assert.equal(normalizeHit({ knowledge_id: 'k', chunk_index: 0, content: '' }), null)
  const hit = normalizeHit({ knowledge_id: 'k', chunk_index: 2, content: 'text', score: 0.5, knowledge_title: 'doc' })
  assert.equal(hit.chunk_index, 2)
  assert.equal(hit.document, 'doc')
})

test('annotateHits drops unprovable and off-topic hits', () => {
  const hits = [
    { knowledge_id: 'k1', chunk_index: 0, content: 'A-17 设备的点检周期为三个月', score: 0.9, knowledge_title: '设备手册' },
    { knowledge_id: '', chunk_index: 0, content: 'A-17 设备的点检周期', score: 0.8 },
    { knowledge_id: 'k2', chunk_index: 1, content: '今天天气很好，适合外出', score: 0.7 },
  ]
  const result = annotateHits(hits, { query: 'A-17 设备的点检周期是多少', minCoverage: 0.34, maxResults: 5 })
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].knowledge_id, 'k1')
  assert.equal(result.diagnostics.dropped_missing_provenance, 1)
  assert.equal(result.diagnostics.dropped_by_coverage, 1)
  assert.equal(result.insufficient, false)
})

test('annotateHits reports insufficient when nothing passes the gate', () => {
  const result = annotateHits(
    [{ knowledge_id: 'k2', chunk_index: 1, content: '今天天气很好', score: 0.7 }],
    { query: 'A-17 设备的点检周期是多少', minCoverage: 0.34 },
  )
  assert.equal(result.hits.length, 0)
  assert.equal(result.insufficient, true)
  assert.equal(result.diagnostics.candidate_count, 1)
})

test('minScore is an optional absolute floor', () => {
  const hits = [{ knowledge_id: 'k1', chunk_index: 0, content: 'A-17 设备的点检周期为三个月', score: 0.2 }]
  assert.equal(annotateHits(hits, { query: 'A-17 设备的点检周期', minScore: 0.5 }).hits.length, 0)
  assert.equal(annotateHits(hits, { query: 'A-17 设备的点检周期', minScore: 0.1 }).hits.length, 1)
})

test('hits are ordered by score then coverage and sliced to maxResults', () => {
  const hits = [
    { knowledge_id: 'a', chunk_index: 0, content: '点检周期 设备 点检周期', score: 0.4 },
    { knowledge_id: 'b', chunk_index: 0, content: '设备 点检 周期', score: 0.9 },
  ]
  const result = annotateHits(hits, { query: '设备点检周期', maxResults: 1 })
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].knowledge_id, 'b')
})
