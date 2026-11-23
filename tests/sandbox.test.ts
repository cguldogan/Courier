import { describe, expect, it } from 'vitest'
import { runScript, type ScriptContext, type ScriptHooks } from '../src/main/sandbox'

function ctx(code: string, extra: Partial<ScriptContext> = {}): ScriptContext {
  return {
    code,
    source: { level: 'request', name: 'r', phase: extra.response ? 'test' : 'pre-request' },
    request: { id: 'r1', name: 'r', method: 'GET', url: 'https://x.test/a?b=1', headers: [{ key: 'Accept', value: '*/*' }], body: { mode: 'none' } },
    vars: { global: { g: 'G' }, collection: { c: 'C' }, environment: { e: 'E', c: 'envC' }, data: { d: 'D' }, local: {} },
    info: { requestName: 'r', requestId: 'r1', iteration: 0, iterationCount: 1, eventName: extra.response ? 'test' : 'prerequest' },
    ...extra
  }
}
const noHooks: ScriptHooks = { sendRequest: async () => ({ code: 200, status: 'OK', headers: [], body: '', responseTime: 1 }) }
const limits = { timeoutMs: 1000, memoryLimitMb: 16 }

describe('sandbox isolation', () => {
  it('exposes no Node / host globals', async () => {
    const out = await runScript(
      ctx(`console.log([typeof process, typeof require, typeof module, typeof globalThis.fetch, typeof XMLHttpRequest, typeof __courier_host, typeof __courier_out, typeof Buffer].join(','))`),
      noHooks,
      limits
    )
    expect(out.error).toBeUndefined()
    expect(out.console[0].message).toBe('undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined')
  })

  it('interrupts an infinite loop at the deadline', async () => {
    const t = Date.now()
    const out = await runScript(ctx('pm.test("before", () => {}); while (true) {}'), noHooks, { timeoutMs: 300, memoryLimitMb: 16 })
    expect(Date.now() - t).toBeLessThan(3000)
    expect(out.error).toMatch(/time limit of 300 ms/)
    expect(out.tests.map((x) => x.name)).toEqual(['before'])
  })

  it('fails a memory bomb cleanly, and the engine keeps working afterwards', async () => {
    const out = await runScript(ctx('const a = []; while (true) a.push("x".repeat(1 << 16));'), noHooks, { timeoutMs: 5000, memoryLimitMb: 16 })
    expect(out.error).toMatch(/memory limit of 16 MB|time limit/)
    const ok = await runScript(ctx('pm.globals.set("after", "ok")'), noHooks, limits)
    expect(ok.error).toBeUndefined()
    expect(ok.vars.global.after).toBe('ok')
  })

  it('stops a script whose async host call never settles, then the next script still runs', async () => {
    const hanging: ScriptHooks = { sendRequest: () => new Promise(() => {}) }
    const out = await runScript(ctx('pm.sendRequest("http://never", () => {})'), hanging, { timeoutMs: 300, memoryLimitMb: 16 })
    expect(out.error).toMatch(/time limit/)
    const ok = await runScript(ctx('pm.test("fine", () => pm.expect(1).to.equal(1))'), noHooks, limits)
    expect(ok.tests).toEqual([{ name: 'fine', passed: true, source: { level: 'request', name: 'r', phase: 'pre-request' } }])
  })

  it('cannot replace the result collector', async () => {
    const out = await runScript(ctx('globalThis.__courier_out = () => "{}"; pm.test("real", () => {})'), noHooks, limits)
    expect(out.tests.map((t) => t.name)).toEqual(['real'])
  })
})

describe('pm API', () => {
  it('variables: scopes, precedence, set/unset mutations, replaceIn', async () => {
    const out = await runScript(
      ctx(`
        pm.environment.set('token', 'abc'); pm.environment.unset('e');
        pm.globals.set('n', 5); pm.collectionVariables.set('obj', {a: 1});
        pm.variables.set('loc', 'L');
        console.log(pm.variables.get('c'), pm.variables.get('d'), pm.variables.get('loc'), pm.environment.has('e'), pm.iterationData.get('d'));
        console.log(pm.variables.replaceIn('{{g}}-{{token}}-{{nope}}'));
      `),
      noHooks,
      limits
    )
    expect(out.error).toBeUndefined()
    expect(out.console.map((c) => c.message)).toEqual(['envC D L false D', 'G-abc-{{nope}}'])
    expect(out.vars.environment).toEqual({ c: 'envC', token: 'abc' })
    expect(out.vars.global).toEqual({ g: 'G', n: '5' })
    expect(out.vars.collection.obj).toBe('{"a":1}')
    expect(out.mutations).toEqual([
      { scope: 'environment', key: 'token', action: 'set', value: 'abc' },
      { scope: 'environment', key: 'e', action: 'unset' },
      { scope: 'global', key: 'n', action: 'set', value: '5' },
      { scope: 'collection', key: 'obj', action: 'set', value: '{"a":1}' },
      { scope: 'local', key: 'loc', action: 'set', value: 'L' }
    ])
  })

  it('pre-request can add/upsert headers and change the URL; tests cannot', async () => {
    const pre = await runScript(ctx(`pm.request.headers.add({key: 'X-A', value: '1'}); pm.request.headers.upsert({key: 'accept', value: 'application/json'}); pm.request.url = 'https://y.test/z'`), noHooks, limits)
    expect(pre.request.headers).toEqual([{ key: 'Accept', value: 'application/json' }, { key: 'X-A', value: '1', disabled: false }])
    expect(pre.request.url).toBe('https://y.test/z')
    const test = await runScript(ctx(`pm.request.headers.add({key: 'X', value: '1'})`, { response: { code: 200, status: 'OK', headers: [], body: '', responseTime: 1, responseSize: 0, cookies: [] } }), noHooks, limits)
    expect(test.error).toMatch(/read-only/)
  })

  it('pm.response, pm.test and a chai-like pm.expect', async () => {
    const out = await runScript(
      ctx(
        `
        pm.test('status', () => pm.response.to.have.status(201));
        pm.test('status text', () => pm.response.to.have.status('Created'));
        pm.test('header', () => pm.response.to.have.header('content-type', 'application/json'));
        pm.test('json', () => {
          const j = pm.response.json();
          pm.expect(j).to.be.an('object').that.has.property('items').with.lengthOf(2);
          pm.expect(j.items[0]).to.deep.equal({ id: 1, tags: ['a'] });
          pm.expect(j).to.have.nested.property('items[1].id', 2);
          pm.expect(j.name).to.include('wid').and.match(/^w/);
          pm.expect(j.count).to.be.above(1).and.below(3).and.within(2, 2);
          pm.expect(j.missing).to.be.undefined;
          pm.expect('x').to.be.oneOf(['x', 'y']);
          pm.expect(j).to.not.be.empty;
          pm.expect(() => { throw new Error('boom') }).to.throw(/boo/);
        });
        pm.test('success flag', () => pm.response.to.be.success);
        pm.test('fails', () => pm.expect(pm.response.code).to.equal(200));
        pm.test('fails negated', () => pm.expect('abc').to.not.include('b'));
        pm.test('time', () => pm.expect(pm.response.responseTime).to.be.below(1000));
        pm.test('async', async () => { const r = await pm.sendRequest('https://h.test'); pm.expect(r.code).to.equal(202) });
      `,
        {
          response: {
            code: 201,
            status: 'Created',
            headers: [['content-type', 'application/json']],
            body: JSON.stringify({ items: [{ id: 1, tags: ['a'] }, { id: 2 }], name: 'widget', count: 2 }),
            responseTime: 12,
            responseSize: 80,
            cookies: []
          }
        }
      ),
      { sendRequest: async () => ({ code: 202, status: 'Accepted', headers: [], body: '', responseTime: 1 }) },
      limits
    )
    expect(out.error).toBeUndefined()
    const byName = Object.fromEntries(out.tests.map((t) => [t.name, t]))
    for (const n of ['status', 'status text', 'header', 'json', 'success flag', 'time', 'async']) expect(byName[n]?.passed, `${n}: ${byName[n]?.error}`).toBe(true)
    expect(byName.fails.passed).toBe(false)
    expect(byName.fails.error).toBe('expected 201 to equal 200')
    expect(byName['fails negated'].error).toBe("expected 'abc' not to include 'b'")
  })

  it('pm.sendRequest supports callback and promise forms; console, btoa/atob, setTimeout, pm.info', async () => {
    const seen: unknown[] = []
    const out = await runScript(
      ctx(`
        pm.sendRequest({ url: 'https://h.test/x', method: 'POST', header: { 'X-K': 'v' }, body: { mode: 'raw', raw: '{"a":1}' } }, (err, res) => {
          pm.environment.set('cb', String(res.code) + ':' + res.json().ok);
        });
        pm.sendRequest('https://h.test/y').then(r => pm.globals.set('promise', r.headers.get('X-Reply')));
        setTimeout(() => console.info('timer fired'), 20);
        console.warn(btoa('user:pass'), atob('dXNlcjpwYXNz'), pm.info.requestName, pm.info.eventName);
      `),
      {
        sendRequest: async (r) => {
          seen.push(r)
          return { code: 200, status: 'OK', headers: [['x-reply', 'yes']], body: '{"ok":true}', responseTime: 3 }
        }
      },
      limits
    )
    expect(out.error).toBeUndefined()
    expect(seen).toEqual([
      { url: 'https://h.test/x', method: 'POST', headers: [['X-K', 'v']], body: '{"a":1}' },
      { url: 'https://h.test/y', method: 'GET', headers: [] }
    ])
    expect(out.vars.environment.cb).toBe('200:true')
    expect(out.vars.global.promise).toBe('yes')
    expect(out.console.map((c) => `${c.level}:${c.message}`)).toEqual(['warn:dXNlcjpwYXNz user:pass r prerequest', 'info:timer fired'])
  })

  it('a syntax error is reported, not thrown', async () => {
    const out = await runScript(ctx('pm.test("x", () => {'), noHooks, limits)
    expect(out.error).toMatch(/SyntaxError/)
  })
})
