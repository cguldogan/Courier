import { CookieJar } from 'tough-cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planRun, runCollection } from '../src/main/runner'
import { CourierCore } from '../src/main/core'
import type { CourierEvents } from '../src/shared/api'
import { parseCsv } from '../src/shared/datafile'
import { newCollection, newFolder, newRequest } from '../src/shared/types'
import { cleanupTempDirs, echoServer, settings, tempDir } from './helpers'

let srv: Awaited<ReturnType<typeof echoServer>>
beforeAll(async () => {
  srv = await echoServer()
})
afterAll(async () => {
  await srv.close()
  cleanupTempDirs()
})

function collection() {
  const login = newRequest({
    id: 'login',
    name: 'Login',
    method: 'POST',
    url: `${srv.url}/login`,
    body: { mode: 'raw', language: 'json', raw: '{"user":"{{user}}"}' },
    testScript: "pm.environment.set('session', 'sess-' + pm.iterationData.get('user')); pm.test('login ok', () => pm.response.to.have.status(200))"
  })
  const profile = newRequest({
    id: 'profile',
    name: 'Profile',
    url: `${srv.url}/profile/{{user}}`,
    headers: [{ key: 'X-Session', value: '{{session}}', enabled: true }],
    testScript: "pm.test('expected role', () => pm.expect(pm.response.json().url).to.include(pm.iterationData.get('expected')))"
  })
  return newCollection({ name: 'Run me', items: [login, newFolder({ id: 'f', name: 'Folder', items: [profile] })] })
}

describe('collection runner', () => {
  it('plans in tree order, by folder, or by explicit ids', () => {
    const c = collection()
    expect(planRun(c, {}).map((p) => p.request.id)).toEqual(['login', 'profile'])
    expect(planRun(c, { folderId: 'f' }).map((p) => p.request.id)).toEqual(['profile'])
    expect(planRun(c, { requestIds: ['profile', 'login'] }).map((p) => p.request.id)).toEqual(['profile', 'login'])
    expect(() => planRun(c, { folderId: 'nope' })).toThrow(/Folder not found/)
  })

  it('iterates over CSV data rows, carries variables between requests, reports progress and a summary', async () => {
    const data = parseCsv('user,expected\nalice,alice\nbob,bob\ncarol,WRONG\n').rows
    const progress: { completed: number; total: number }[] = []
    const c = collection()
    const n = srv.requests.length
    const out = await runCollection(
      { runId: 'r1', collection: c, plan: planRun(c, {}), vars: { global: {}, collection: {}, environment: {}, data: {}, local: {} }, iterations: 1, delayMs: 10, stopOnFailure: false, data, onProgress: (p) => progress.push({ completed: p.completed, total: p.total }) },
      { settings: settings(), cookieJar: new CookieJar() }
    )
    const s = out.summary
    expect(s.iterations).toBe(3)
    expect(s.totalRequests).toBe(6)
    expect(progress.map((p) => `${p.completed}/${p.total}`)).toEqual(['1/6', '2/6', '3/6', '4/6', '5/6', '6/6'])
    expect(s.totalTests).toBe(6)
    expect(s.failedTests).toBe(1)
    expect(s.failedRequests).toBe(1)
    expect(s.results.map((r) => `${r.iteration}:${r.name}:${r.passed}`)).toEqual(['0:Login:true', '0:Profile:true', '1:Login:true', '1:Profile:true', '2:Login:true', '2:Profile:false'])
    const sent = srv.requests.slice(n)
    expect(sent.map((r) => `${r.method} ${r.url} ${r.headers['x-session'] ?? ''}`)).toEqual([
      'POST /login ',
      'GET /profile/alice sess-alice',
      'POST /login ',
      'GET /profile/bob sess-bob',
      'POST /login ',
      'GET /profile/carol sess-carol'
    ])
    expect(out.vars.environment.session).toBe('sess-carol')
    expect(out.mutations.filter((m) => m.scope === 'environment')).toHaveLength(3)
  })

  it('stops on failure and can be cancelled', async () => {
    const c = collection()
    const stop = await runCollection(
      { runId: 'r2', collection: c, plan: planRun(c, {}), vars: { global: {}, collection: {}, environment: {}, data: {}, local: {} }, iterations: 1, delayMs: 0, stopOnFailure: true, data: [{ user: 'x', expected: 'nope' }, { user: 'y', expected: 'y' }] },
      { settings: settings() }
    )
    expect(stop.summary.stopped).toBe(true)
    expect(stop.summary.stoppedReason).toBe('failure')
    expect(stop.summary.totalRequests).toBe(2)

    const ac = new AbortController()
    const p = runCollection(
      { runId: 'r3', collection: c, plan: planRun(c, {}), vars: { global: {}, collection: {}, environment: {}, data: {}, local: {} }, iterations: 50, delayMs: 50, stopOnFailure: false, signal: ac.signal },
      { settings: settings() }
    )
    setTimeout(() => ac.abort(), 120)
    const cancelled = await p
    expect(cancelled.summary.stoppedReason).toBe('user')
    expect(cancelled.summary.totalRequests).toBeLessThan(100)
  })

  it('core.startRun emits runner:progress / runner:finished and persists environment changes', async () => {
    const events: { name: string; payload: unknown }[] = []
    const core = new CourierCore({ userDataDir: tempDir(), emit: (name, payload) => events.push({ name, payload }) })
    await core.init()
    const { collection: col } = await core.createCollection({ name: 'R' })
    await core.saveCollection({ ...collection(), id: col.id })
    const { environment: env } = await core.createEnvironment({ name: 'Env' })
    await core.setActiveEnvironment(env.id)
    const { runId, done } = await core.startRun({ collectionId: col.id, data: [{ user: 'dora', expected: 'dora' }] })
    await done
    const finished = events.find((e) => e.name === 'runner:finished')!.payload as CourierEvents['runner:finished']
    expect(finished.runId).toBe(runId)
    expect(finished.failedTests).toBe(0)
    expect(events.filter((e) => e.name === 'runner:progress')).toHaveLength(2)
    const snap = await core.load()
    expect(snap.currentValues.environments[env.id]).toEqual({ session: 'sess-dora' })
  })
})
