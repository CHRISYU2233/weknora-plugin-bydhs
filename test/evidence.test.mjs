import test from 'node:test'
import assert from 'node:assert/strict'
import { renderEvidence, renderInsufficient, renderUnavailable } from '../evidence.js'

const hits = [
  {
    marker: 'K1',
    knowledge_id: '8f14e45f-ceea-467a-9c1a-2b3d4e5f6a7b',
    chunk_index: 3,
    document: '设备手册',
    score: 0.91,
    coverage: 0.62,
    content: 'A-17 设备的点检周期为三个月，由设备科执行。',
  },
  {
    marker: 'K2',
    knowledge_id: '0c5f2a11-1111-4222-8333-444455556666',
    chunk_index: 7,
    document: '维保规程',
    score: 0.75,
    coverage: 0.48,
    content: '点检记录需在当月 5 日前归档。',
  },
]

test('evidence block carries markers, provenance and the rule block', () => {
  const result = renderEvidence({ hits, query: 'A-17 点检周期', turn: 2, kbIds: ['kb-1'] })
  assert.match(result.block, /<kb-evidence turn="2" source="pre-step"/)
  assert.match(result.block, /\[K1\] 《设备手册》 · knowledge_id: 8f14e45f/)
  assert.match(result.block, /chunk: 3/)
  assert.match(result.block, /<kb-rule>/)
  assert.match(result.block, /知识库中没有足够证据/)
  assert.equal(result.included, 2)
  assert.equal(result.omitted, 0)
})

test('the budget cuts the block and reports how many passages were omitted', () => {
  const long = hits.map((hit) => ({ ...hit, content: '很长的内容'.repeat(80) }))
  const result = renderEvidence({ hits: long, query: 'q', budget: 900 })
  assert.ok(result.included >= 1)
  assert.ok(result.omitted >= 1)
  assert.ok(result.block.length <= 900)
  assert.match(result.block, /另有 \d+ 条片段未展示/)
})

test('failed knowledge bases are named inside the block', () => {
  const result = renderEvidence({
    hits,
    query: 'q',
    failures: [{ kbId: 'kb-corp', error: 'HTTP 401' }],
  })
  assert.match(result.block, /kb-corp: HTTP 401/)
  assert.match(result.block, /证据不完整/)
})

test('insufficient block states the gate that rejected everything', () => {
  const result = renderInsufficient({
    query: 'A-17 点检周期',
    turn: 1,
    kbIds: ['kb-1'],
    diagnostics: { candidate_count: 6, top_coverage: 0.11, min_coverage: 0.34, dropped_missing_provenance: 1 },
  })
  assert.match(result.block, /insufficient="true"/)
  assert.match(result.block, /候选片段 6 条/)
  assert.match(result.block, /最高覆盖率 0.11/)
  assert.match(result.block, /不得凭记忆或常识回答/)
})

test('unavailable block distinguishes a failed retrieval from empty evidence', () => {
  const result = renderUnavailable({ query: 'q', failures: [{ error: 'ECONNREFUSED' }] })
  assert.match(result.block, /unavailable="true"/)
  assert.match(result.block, /ECONNREFUSED/)
  assert.match(result.block, /不要把"检索失败"说成"知识库没有证据"/)
})
