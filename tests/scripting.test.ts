/**
 * Phase 3 scripting: pm.execution.setNextRequest / postman.setNextRequest in the runner (order, null
 * stops, loop guard, unknown name), pm.execution.skipRequest, pm.cookies + pm.cookies.jar() on the
 * tough-cookie jar, pm.visualizer.set (main-process Handlebars subset, escaping, CSP) and how all of
 * them interact with the script → Key Vault gate and secret masking. Local servers only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CookieJar } from 'tough-cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeRequest, type ExecutorDeps } from '../src/main/executor'
import { planRun, runCollection } from '../src/main/runner'
import { LIMITS, renderTemplate, renderVisualizer } from '../src/main/visualizer'
import { newCollection, newRequest, type Collection, type RequestDef } from '../src/shared/types'
import { cleanupTempDirs, echoServer, makeCore, settings } from './helpers'

let srv: Awaited<ReturnType<typeof echoServer>>
beforeAll(async () => {
  srv = await echoServer({
    '/setc': (_req, res) => {
      res.setHeader('set-cookie', ['sess=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'])
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    },
    '/reflect': (req, res) => {
      // A server that echoes a secret header back as a cookie and in the body.
      res.setHeader('set-cookie', `leak=${req.headers['x-secret']}; Path=/`)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ secret: req.headers['x-secret'], items: [{ name: '<b>x</b>' }] }))
    }
  })
})
afterAll(async () => {
  await srv.close()
  cleanupTempDirs()
})

const vars = () => ({ global: {}, collection: {}, environment: {}, data: {}, local: {} })
const deps = (extra: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ settings: settings(), cookieJar: new CookieJar(), ...extra })

function req(name: string, testScript = '', preRequestScript = ''): RequestDef {
  return newRequest({ id: `id-${name}`, name, url: `${srv.url}/r/${name}`, testScript, preRequestScript })
}
async function run(c: Collection, opts: { iterations?: number; maxJumps?: number; jar?: CookieJar } = {}) {
  return runCollection(
    { runId: 'r', collection: c, plan: planRun(c, {}), vars: vars(), iterations: opts.iterations ?? 1, delayMs: 0, stopOnFailure: false, ...(opts.maxJumps ? { maxJumps: opts.maxJumps } : {}) },
    deps({ cookieJar: opts.jar ?? new CookieJar() })
  )
}
const order = (o: Awaited<ReturnType<typeof run>>): string[] => o.summary.results.map((r) => r.name)

describe('setNextRequest in the runner', () => {
  it('jumps by name or id within the run; null stops the run', async () => {
    const c = newCollection({
      name: 'Flow',
      items: [req('A', "pm.execution.setNextRequest('C')"), req('B'), req('C', "postman.setNextRequest('id-E')"), req('D'), req('E', 'pm.execution.setNextRequest(null)'), req('F')]
    })
    const out = await run(c)
    expect(order(out)).toEqual(['A', 'C', 'E'])
    expect(out.summary.stopped).toBe(true)
    expect(out.summary.stoppedReason).toBe('script')
    expect(out.summary.stopMessage).toMatch(/setNextRequest\(null\) in "E"/)
  })

  it('a polling loop: the same request until a condition holds, then on in order', async () => {
    const c = newCollection({
      name: 'Poll',
      items: [
        req('Poll', "var n = Number(pm.collectionVariables.get('n') || 0) + 1; pm.collectionVariables.set('n', String(n)); if (n < 3) pm.execution.setNextRequest('Poll');"),
        req('After')
      ]
    })
    expect(order(await run(c))).toEqual(['Poll', 'Poll', 'Poll', 'After'])
  })

  it('a pre-request setNextRequest also counts; the jump stays within the iteration', async () => {
    const c = newCollection({ name: 'Iter', items: [req('A', '', "pm.execution.setNextRequest('C')"), req('B'), req('C')] })
    const out = await run(c, { iterations: 2 })
    expect(out.summary.results.map((r) => `${r.iteration}:${r.name}`)).toEqual(['0:A', '0:C', '1:A', '1:C'])
  })

  it('loop guard: an endless loop stops with a clear error after maxJumps', async () => {
    const c = newCollection({ name: 'Loop', items: [req('Spin', "pm.execution.setNextRequest('Spin')"), req('Never')] })
    const out = await run(c, { maxJumps: 5 })
    expect(order(out)).toEqual(Array(6).fill('Spin'))
    expect(out.summary.stoppedReason).toBe('loop-guard')
    expect(out.summary.stopMessage).toMatch(/after 5 setNextRequest jumps.*loop guard/)
  })

  it('an unknown name stops the run with an error naming it', async () => {
    const out = await run(newCollection({ name: 'X', items: [req('A', "pm.execution.setNextRequest('Nope')"), req('B')] }))
    expect(order(out)).toEqual(['A'])
    expect(out.summary.stoppedReason).toBe('error')
    expect(out.summary.stopMessage).toMatch(/"Nope".*no request with that name or id in this run/)
  })

  it('only requests of this run count (a folder run cannot jump outside the folder)', async () => {
    const c = newCollection({ name: 'Scoped', items: [req('Outside'), { type: 'folder', id: 'f', name: 'F', description: '', auth: { type: 'inherit' }, preRequestScript: '', testScript: '', items: [req('In1', "pm.execution.setNextRequest('Outside')"), req('In2')] }] })
    const out = await runCollection({ runId: 'r', collection: c, plan: planRun(c, { folderId: 'f' }), vars: vars(), iterations: 1, delayMs: 0, stopOnFailure: false }, deps())
    expect(order(out)).toEqual(['In1'])
    expect(out.summary.stoppedReason).toBe('error')
  })

  it('a single Send ignores setNextRequest (reported, not acted on)', async () => {
    const r = await executeRequest({ collection: null, folders: [], request: req('Solo', "pm.execution.setNextRequest('Other')"), vars: vars() }, deps(), { executionId: 's' })
    expect(r.response?.status).toBe(200)
    expect(r.nextRequest).toEqual({ value: 'Other' })
  })
})

describe('pm.execution.skipRequest', () => {
  it('a pre-request skip sends nothing and runs no tests; the runner counts it as skipped', async () => {
    const before = srv.requests.length
    const r = await executeRequest({ collection: null, folders: [], request: req('Skip', "pm.test('never', () => {})", 'pm.execution.skipRequest()'), vars: vars() }, deps(), { executionId: 's' })
    expect(r.skipped).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.tests).toEqual([])
    expect(srv.requests.length).toBe(before)
    const out = await run(newCollection({ name: 'S', items: [req('Skip', '', 'pm.execution.skipRequest()'), req('Next')] }))
    expect(out.summary.results.map((x) => [x.name, x.skipped ?? false, x.passed])).toEqual([
      ['Skip', true, true],
      ['Next', false, true]
    ])
  })
  it('is refused in test scripts', async () => {
    const r = await executeRequest({ collection: null, folders: [], request: req('T', 'pm.execution.skipRequest()'), vars: vars() }, deps(), { executionId: 's' })
    expect(r.scriptErrors[0].message).toMatch(/only be used in pre-request scripts/)
  })
})

describe('pm.cookies and pm.cookies.jar()', () => {
  it('pm.cookies has/get/toObject for the request URL (httpOnly included); the jar API with callbacks and promises', async () => {
    const jar = new CookieJar()
    const d = deps({ cookieJar: jar })
    await executeRequest({ collection: null, folders: [], request: newRequest({ url: `${srv.url}/setc` }), vars: vars() }, d, { executionId: 'c' })
    const script = `
      pm.test('pm.cookies', () => {
        pm.expect(pm.cookies.has('sess')).to.be.true;
        pm.expect(pm.cookies.get('sess')).to.equal('abc123');
        pm.expect(pm.cookies.toObject()).to.eql({ sess: 'abc123', theme: 'dark' });
      });
      const jar = pm.cookies.jar();
      jar.set(pm.request.url.toString(), 'fromScript', 'v1', (err, c) => { pm.test('set callback', () => { pm.expect(err).to.equal(null); pm.expect(c.name).to.equal('fromScript'); }); });
      jar.set(pm.request.url.toString(), { name: 'secureish', value: 'v2', httpOnly: true }).then(() =>
        jar.get(pm.request.url.toString(), 'secureish').then((v) => pm.test('get promise', () => pm.expect(v).to.equal('v2')))
      ).then(() => jar.unset(pm.request.url.toString(), 'theme'))
       .then(() => jar.getAll(pm.request.url.toString()))
       .then((all) => pm.test('getAll after unset', () => pm.expect(all.map((c) => c.name).sort()).to.eql(['fromScript', 'secureish', 'sess'])));
      jar.get('http://other.example.com/', 'sess', (err) => pm.test('other hosts are refused', () => pm.expect(String(err && err.message)).to.include("only access cookies of this request's host")));
    `
    const r = await executeRequest({ collection: null, folders: [], request: newRequest({ url: `${srv.url}/page`, testScript: script }), vars: vars() }, d, { executionId: 'c2' })
    expect(r.scriptErrors).toEqual([])
    expect(r.tests.map((t) => `${t.name}:${t.passed}${t.error ? ':' + t.error : ''}`).sort()).toEqual(['get promise:true', 'getAll after unset:true', 'other hosts are refused:true', 'pm.cookies:true', 'set callback:true'])
    expect(r.cookiesChanged).toBe(true)
    // The next request carries the cookies the script set.
    await executeRequest({ collection: null, folders: [], request: newRequest({ url: `${srv.url}/next` }), vars: vars() }, d, { executionId: 'c3' })
    expect(srv.requests.at(-1)!.headers.cookie).toBe('sess=abc123; fromScript=v1; secureish=v2')
    // clear
    await executeRequest({ collection: null, folders: [], request: newRequest({ url: `${srv.url}/x`, testScript: 'pm.cookies.jar().clear(pm.request.url.toString())' }), vars: vars() }, d, { executionId: 'c4' })
    expect(await jar.getCookies(srv.url)).toEqual([])
  })

  it('cookie changes from scripts persist like other cookie changes (core: cookie manager + userData)', async () => {
    const core = await makeCore()
    const events: string[] = []
    ;(core as unknown as { emit: (e: string) => void }).emit = (e: string) => events.push(e)
    const r = await core.send({ draft: newRequest({ url: `${srv.url}/p`, testScript: "pm.cookies.jar().set(pm.request.url.toString(), 'persisted', 'yes')" }) })
    expect(r.scriptErrors).toEqual([])
    expect((await core.listCookies()).map((c) => `${c.key}=${c.value}`)).toContain('persisted=yes')
    expect(events).toContain('cookies:changed')
    const file = readFileSync(join((core.store as unknown as { root: string }).root, 'cookies.json'), 'utf8')
    expect(file).toContain('persisted')
  })
})

describe('pm.visualizer', () => {
  it('renders the Handlebars subset: paths, each/@index/@key/@first/@last, if/else, unless, with, ../, comments, ~', () => {
    const tpl = `{{! comment }}<h1>{{title}}</h1>{{#each rows}}<p>{{@index}}:{{name}}/{{../title}}{{#if @first}} first{{/if}}{{#if @last}} last{{/if}}</p>{{else}}none{{/each}}
{{#each map}}[{{@key}}={{this}}]{{/each}}{{#if missing}}yes{{else}}no{{/if}}{{#unless missing}}!{{/unless}}{{#with nested}}<i>{{deep.v}} {{[odd key]}} {{@root.title}}</i>{{/with}}  {{~title~}}  .`
    const html = renderTemplate(tpl, { title: 'T', rows: [{ name: 'a' }, { name: 'b' }], map: { x: 1, y: 2 }, nested: { deep: { v: 'V' }, 'odd key': 'O' } })
    expect(html).toBe('<h1>T</h1><p>0:a/T first</p><p>1:b/T last</p>\n[x=1][y=2]no!<i>V O T</i>T.')
    expect(renderTemplate('{{#each list}}x{{else}}empty{{/each}}', { list: [] })).toBe('empty')
  })

  it('escapes {{x}} and {{{x}}} alike; no prototype access; unsupported syntax is an error', () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    const out = renderTemplate('{{v}}|{{{v}}}', { v: evil })
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;')
    expect(renderTemplate('[{{constructor}}][{{v.__proto__}}][{{toString}}][{{v.length}}]', { v: 'abc' })).toBe('[][][][3]')
    expect(() => renderTemplate('{{#each (lookup a b)}}{{/each}}', {})).toThrow(/Unsupported/)
    expect(() => renderTemplate('{{helper arg}}', {})).toThrow(/Unsupported expression/)
    expect(() => renderTemplate('{{#if a}}', {})).toThrow(/Missing \{\{\/if\}\}/)
    expect(() => renderTemplate('{{#each a}}{{/each}}', { a: Array.from({ length: LIMITS.iterations + 1 }, () => 1) })).toThrow(/loop iterations/)
  })

  it('wraps the output in a document whose CSP forbids scripts and every network load', () => {
    const { html } = renderVisualizer('<script>document.title="x"</script><img src="https://example.com/i.png">', {})
    expect(html.indexOf('<meta http-equiv="Content-Security-Policy"')).toBeLessThan(html.indexOf('<script>'))
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/script-src|img-src [^;]*https/)
    const bad = renderVisualizer('{{#if}}', {})
    expect(bad.error).toBeTruthy()
    expect(bad.html).toContain('Visualizer template error')
  })

  it('pm.visualizer.set in a test script produces the Visualize HTML from response data', async () => {
    const r = await executeRequest(
      { collection: null, folders: [], request: newRequest({ url: `${srv.url}/v`, testScript: "pm.visualizer.set('<table>{{#each rows}}<tr><td>{{this}}</td></tr>{{/each}}</table><p>{{method}}</p>', { rows: ['r1', '<r2>'], method: pm.response.json().method })" }), vars: vars() },
      deps(),
      { executionId: 'v' }
    )
    expect(r.visualizer?.html).toContain('<table><tr><td>r1</td></tr><tr><td>&lt;r2&gt;</td></tr></table><p>GET</p>')
    const cleared = await executeRequest({ collection: null, folders: [], request: newRequest({ url: `${srv.url}/v`, preRequestScript: "pm.visualizer.set('x')", testScript: 'pm.visualizer.clear()' }), vars: vars() }, deps(), { executionId: 'v2' })
    expect(cleared.visualizer).toBeUndefined()
  })
})

describe('gate interactions: visualizer and cookies are no way around secret masking', () => {
  const SECRET = 'Vault-Secr3t-For-Gate-99'
  const vault = { resolve: async () => SECRET }
  const request = (testScript: string) => newRequest({ url: `${srv.url}/reflect`, headers: [{ key: 'X-Secret', value: '{{vault:kv/s}}', enabled: true }], testScript })
  const leakScript = (): string => `
    const fromCookie = pm.cookies.get('leak');
    pm.cookies.jar().get(pm.request.url.toString(), 'leak').then((v) => pm.sendRequest('${srv.url}/exfil?c=' + encodeURIComponent(v)));
    pm.visualizer.set('<p>{{a}}|{{b}}|{{c}}</p>', { a: pm.response.json().secret, b: fromCookie, c: pm.response.cookies.get('leak') });
    console.log('cookie', fromCookie);
  `

  it('a blocked script sees the reflected secret masked in pm.cookies, the jar and the visualizer; it cannot exfiltrate it', async () => {
    const jar = new CookieJar()
    const r = await executeRequest({ collection: null, folders: [], request: request(leakScript()), vars: vars() }, deps({ cookieJar: jar, vault, scriptVault: { allowed: false, reason: 'not-allowed' } }), { executionId: 'g' })
    expect(r.response?.status).toBe(200)
    expect(srv.requests.at(-2)!.headers['x-secret']).toBe(SECRET) // the declarative reference itself still resolves
    const exfil = srv.requests.at(-1)!
    expect(exfil.url).toMatch(/^\/exfil/)
    expect(decodeURIComponent(exfil.url)).not.toContain(SECRET)
    expect(decodeURIComponent(exfil.url)).toContain('••••')
    expect(r.visualizer?.html).toContain('<p>••••|••••|••••</p>')
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('a secret containing HTML-special characters is still masked after the visualizer escapes it', async () => {
    const tricky = 'Pa<ss>&"word=1'
    const r = await executeRequest(
      { collection: null, folders: [], request: newRequest({ url: `${srv.url}/reflect`, headers: [{ key: 'X-Secret', value: '{{vault:kv/t}}', enabled: true }], testScript: "pm.visualizer.set('{{s}}', { s: 'x' + pm.response.json().secret })" }), vars: vars() },
      deps({ vault: { resolve: async () => tricky }, scriptVault: { allowed: true } }),
      { executionId: 'g2' }
    )
    expect(r.visualizer?.html).toContain('x••••')
    expect(r.visualizer?.html).not.toContain('Pa&lt;ss')
  })
})
