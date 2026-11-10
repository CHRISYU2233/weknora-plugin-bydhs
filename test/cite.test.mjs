import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkers, parseInlineCitations, verifyCitations, renderCitationReport } from '../cite.js'

const pages = [
  {
    source: 'pre-step',
    turn: 1,
    hits: [
      { marker: 'K1', knowledge_id: '8f14e45f-ceea-467a-9c1a-2b3d4e5f6a7b', chunk_index: 3, document: '设备手册' },
      { marker: 'K2', knowledge_id: '0c5f2a11-1111-4222-8333-444455556666', chunk_index: 7, document: '维保规程' },
    ],
  },
]

test('parseMarkers returns unique markers in first-seen order', () => {
  assert.deepEqual(parseMarkers('先说 [K2]，再补 [K1]，重复 [K2]'), ['K2', 'K1'])
  assert.deepEqual(parseMarkers('没有引用'), [])
})

test('parseInlineCitations reads knowledge_id and the nearby chunk index', () => {
  const found = parseInlineCitations('依据 knowledge_id: 8f14e45f-ceea-467a-9c1a-2b3d4e5f6a7b · chunk: 12 的记载')
  assert.equal(found.length, 1)
  assert.equal(found[0].knowledge_id, '8f14e45f-ceea-467a-9c1a-2b3d4e5f6a7b')
  assert.equal(found[0].chunk_index, 12)
})

test('all citations verified', () => {
  const result = verifyCitations({
    answer: '点检周期为三个月 [K1]，记录需归档 [K2]。',
    pages,
  })
  assert.equal(result.ok, true)
  assert.equal(result.total, 2)
  assert.equal(result.verified, 2)
})

test('a marker that no retrieved page contains is unknown_source', () => {
  const result = verifyCitations({ answer: '结论 [K9]', pages })
  assert.equal(result.ok, false)
  assert.equal(result.citations[0].status, 'unknown_source')
})

test('an inline knowledge_id outside the evidence is not_in_evidence', () => {
  const result = verifyCitations({
    answer: '见 knowledge_id: deadbeef-0000-0000-0000-000000000000 chunk: 1',
    pages,
  })
  assert.equal(result.ok, false)
  assert.equal(result.citations[0].status, 'not_in_evidence')
})

test('an inline knowledge_id with a wrong chunk index does not verify', () => {
  const result = verifyCitations({
    answer: '见 knowledge_id: 8f14e45f-ceea-467a-9c1a-2b3d4e5f6a7b · chunk: 99',
    pages,
  })
  assert.equal(result.ok, false)
  assert.equal(result.citations[0].status, 'not_in_evidence')
  assert.match(result.citations[0].detail, /chunk 99/)
})

test('requireChunk flags a bare knowledge_id', () => {
  const result = verifyCitations({
    answer: '见 knowledge_id: 8f14e45f-ceea-467a-9c1a-2b3d4e5f6a7b',
    pages,
    requireChunk: true,
  })
  assert.equal(result.citations[0].status, 'malformed')
})

test('an answer without any citation is not ok', () => {
  const result = verifyCitations({ answer: '点检周期为三个月。', pages })
  assert.equal(result.ok, false)
  assert.equal(result.total, 0)
  assert.match(result.notes, /没有找到任何引用/)
})

test('the report renders one line per citation', () => {
  const result = verifyCitations({ answer: '[K1] [K9]', pages })
  const report = renderCitationReport(result)
  assert.match(report, /引用自检：1\/2 通过/)
  assert.match(report, /\[K9\] · unknown_source/)
})
