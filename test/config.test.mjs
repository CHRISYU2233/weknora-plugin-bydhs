import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, ConfigError, normalizeBaseUrl } from '../config.js'

test('defaults include the grounding knobs', () => {
  const c = resolveConfig({})
  assert.equal(c.injectEvidence, true)
  assert.equal(c.policyOrder, 10_500)
  assert.equal(c.minCoverage, 0.34)
  assert.equal(c.minScore, undefined)
  assert.equal(c.maxInjectedChars, 4_000)
  assert.equal(c.injectTopK, 6)
  assert.equal(c.temperatureCap, 0.2)
  assert.equal(c.perKbIsolation, true)
  assert.equal(c.toolPrefix, 'wkg')
  assert.equal(c.enforce, true)
})

test('normalizeBaseUrl accepts an origin or an API root', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/api/v1')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/api/v1/'), 'http://127.0.0.1:8080/api/v1')
  assert.equal(resolveConfig({ baseUrl: 'https://kb.example.com' }).baseUrl, 'https://kb.example.com/api/v1')
})

test('invalid fields are named one by one at load time', () => {
  assert.throws(
    () => resolveConfig({ minCoverage: 2, policyOrder: 1.5, injectEvidence: 'yes', temperatureCap: 9, perKbIsolation: 'no' }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      for (const field of ['minCoverage', 'policyOrder', 'injectEvidence', 'temperatureCap', 'perKbIsolation']) {
        assert.match(error.message, new RegExp(field))
      }
      return true
    },
  )
})

test('temperatureCap: null disables the cap, a number is accepted', () => {
  assert.equal(resolveConfig({ temperatureCap: null }).temperatureCap, null)
  assert.equal(resolveConfig({ temperatureCap: 0 }).temperatureCap, 0)
})

test('minScore accepts a unit interval value only', () => {
  assert.equal(resolveConfig({ minScore: 0.5 }).minScore, 0.5)
  assert.throws(() => resolveConfig({ minScore: 1.2 }), ConfigError)
})

test('a negative policyOrder is allowed (first-party sections start at -1000)', () => {
  assert.equal(resolveConfig({ policyOrder: -50 }).policyOrder, -50)
})
