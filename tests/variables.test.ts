import { describe, expect, it } from 'vitest'
import {
  buildUrl,
  effectiveValues,
  emptyLayers,
  findVaultRefs,
  lookupVariable,
  parseVaultRef,
  resolveTemplate,
  splitQuery,
  toVaultTemplate
} from '../src/shared/variables'

describe('variable precedence', () => {
  const layers = {
    global: { a: 'global', b: 'global', c: 'global', d: 'global', e: 'global' },
    collection: { b: 'collection', c: 'collection', d: 'collection', e: 'collection' },
    environment: { c: 'environment', d: 'environment', e: 'environment' },
    data: { d: 'data', e: 'data' },
    local: { e: 'local' }
  }
  it('narrowest scope wins: local > data > environment > collection > global', () => {
    expect(lookupVariable('a', layers)).toBe('global')
    expect(lookupVariable('b', layers)).toBe('collection')
    expect(lookupVariable('c', layers)).toBe('environment')
    expect(lookupVariable('d', layers)).toBe('data')
    expect(lookupVariable('e', layers)).toBe('local')
    expect(resolveTemplate('{{a}}-{{b}}-{{c}}-{{d}}-{{e}}', layers)).toBe('global-collection-environment-data-local')
  })

  it('resolves nested references and leaves unknown names untouched', () => {
    const l = { ...emptyLayers(), environment: { host: 'api.test', base: 'https://{{host}}/v1' } }
    expect(resolveTemplate('{{base}}/users/{{ missing }}', l)).toBe('https://api.test/v1/users/{{ missing }}')
  })

  it('stops on self-referencing cycles', () => {
    const l = { ...emptyLayers(), global: { loop: '{{loop}}x' } }
    expect(resolveTemplate('{{loop}}', l).startsWith('{{loop}}')).toBe(true)
  })

  it('leaves {{vault:…}} references for main to resolve', () => {
    const l = { ...emptyLayers(), environment: { key: '{{vault:kv/api-key}}' } }
    expect(resolveTemplate('Bearer {{key}}', l)).toBe('Bearer {{vault:kv/api-key}}')
    expect(findVaultRefs('a {{vault:x}} b {{ vault:kv/y@abc123 }}')).toEqual(['x', 'kv/y@abc123'])
  })
})

describe('dynamic variables', () => {
  it('generates fresh values per occurrence', () => {
    const out = resolveTemplate('{{$guid}}|{{$guid}}|{{$timestamp}}|{{$isoTimestamp}}|{{$randomInt}}|{{$randomEmail}}|{{$randomUUID}}', emptyLayers())
    const [g1, g2, ts, iso, int, email, uuid] = out.split('|')
    expect(g1).toMatch(/^[0-9a-f-]{36}$/)
    expect(g1).not.toBe(g2)
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5)
    expect(new Date(iso).toISOString()).toBe(iso)
    expect(Number(int)).toBeGreaterThanOrEqual(0)
    expect(email).toMatch(/^[^@]+@example\.com$/)
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('a defined variable shadows a dynamic one', () => {
    expect(resolveTemplate('{{$guid}}', { ...emptyLayers(), local: { $guid: 'fixed' } })).toBe('fixed')
  })
})

describe('effective values', () => {
  it('current values override shared values, disabled vars are skipped, vault vars become refs', () => {
    const vals = effectiveValues(
      [
        { key: 'url', value: 'https://shared', enabled: true, type: 'default' },
        { key: 'off', value: 'x', enabled: false, type: 'default' },
        { key: 'token', value: '', enabled: true, type: 'secret' },
        { key: 'apiKey', value: 'kv/api-key', enabled: true, type: 'vault' }
      ],
      { url: 'https://mine', token: 's3cr3t', extra: 'from-script' }
    )
    expect(vals).toEqual({ url: 'https://mine', token: 's3cr3t', apiKey: '{{vault:kv/api-key}}', extra: 'from-script' })
  })
})

describe('vault refs', () => {
  it('parses name, alias/name and @version in all spellings', () => {
    expect(parseVaultRef('db-password')).toEqual({ name: 'db-password' })
    expect(parseVaultRef('kv2/db-password')).toEqual({ alias: 'kv2', name: 'db-password' })
    expect(parseVaultRef('{{vault:kv2/db-password@0123abcd}}')).toEqual({ alias: 'kv2', name: 'db-password', version: '0123abcd' })
    expect(parseVaultRef('vault:x')).toEqual({ name: 'x' })
    expect(parseVaultRef('bad name')).toBeNull()
    expect(toVaultTemplate('kv/x')).toBe('{{vault:kv/x}}')
  })
})

describe('url helpers', () => {
  it('splits and rebuilds query strings, keeps templates unencoded, fills path variables', () => {
    const { base, params } = splitQuery('https://x.test/a?b=1&c=two%20words&flag')
    expect(base).toBe('https://x.test/a')
    expect(params.map((p) => [p.key, p.value])).toEqual([['b', '1'], ['c', 'two words'], ['flag', '']])
    expect(buildUrl('https://x.test/users/:id', [{ key: 'q', value: 'a b&c', enabled: true }, { key: 'off', value: '1', enabled: false }, { key: 't', value: '{{tok}}', enabled: true }], [{ key: 'id', value: '4 2', enabled: true }])).toBe(
      'https://x.test/users/4%202?q=a%20b%26c&t={{tok}}'
    )
  })
})
