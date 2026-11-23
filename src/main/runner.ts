/**
 * Collection runner (pure Node): ordered requests × iterations (or data rows), delay, stop-on-failure,
 * cancellation, live progress callback and a summary. Variables carry over between requests and
 * iterations; `data` is replaced per iteration; `local` is reset per request.
 */
import type { Collection, Folder, Id, RequestDef, RunItemResult, RunSummary, VariableMutation } from '../shared/types'
import { walkItems } from '../shared/types'
import { Fault } from './errors'
import { executeRequest, type ExecutorDeps } from './executor'
import type { ScriptVars } from './sandbox'

export interface RunPlanItem {
  request: RequestDef
  folders: Folder[]
}

export function planRun(collection: Collection, opts: { folderId?: Id; requestIds?: Id[] }): RunPlanItem[] {
  let all: RunPlanItem[] = []
  for (const { item, parents } of walkItems(collection.items)) if (item.type === 'request') all.push({ request: item, folders: parents })
  if (opts.folderId) {
    const exists = [...walkItems(collection.items)].some((e) => e.item.id === opts.folderId && e.item.type === 'folder')
    if (!exists) throw new Fault('NOT_FOUND', 'Folder not found in collection.')
    all = all.filter((p) => p.folders.some((f) => f.id === opts.folderId))
  }
  if (opts.requestIds && opts.requestIds.length) {
    const byId = new Map(all.map((p) => [p.request.id, p]))
    all = opts.requestIds.map((id) => byId.get(id)).filter((p): p is RunPlanItem => p !== undefined)
  }
  return all
}

export interface RunOptions {
  runId: string
  collection: Collection
  plan: RunPlanItem[]
  vars: ScriptVars
  iterations: number
  delayMs: number
  stopOnFailure: boolean
  data?: Record<string, string>[]
  signal?: AbortSignal
  onProgress?: (p: { completed: number; total: number; result: RunItemResult }) => void
}

export interface RunOutcome {
  summary: RunSummary
  /** All variable mutations in order (for persistence). */
  mutations: VariableMutation[]
  vars: ScriptVars
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

export async function runCollection(opts: RunOptions, deps: ExecutorDeps): Promise<RunOutcome> {
  const started = Date.now()
  const iterations = opts.data && opts.data.length ? opts.data.length : Math.max(1, Math.floor(opts.iterations || 1))
  const total = iterations * opts.plan.length
  const results: RunItemResult[] = []
  const mutations: VariableMutation[] = []
  let stopped = false
  let stoppedReason: RunSummary['stoppedReason']
  let completed = 0
  // Values before any script of the run: a script must not steer a later request's Key Vault
  // references elsewhere through carried-over variables (see executor.ts).
  const runStart = structuredClone(opts.vars)

  outer: for (let it = 0; it < iterations; it++) {
    opts.vars.data = opts.data && opts.data.length ? { ...opts.data[it] } : {}
    for (let i = 0; i < opts.plan.length; i++) {
      if (opts.signal?.aborted) {
        stopped = true
        stoppedReason = 'user'
        break outer
      }
      const { request, folders } = opts.plan[i]
      opts.vars.local = {}
      const exec = await executeRequest(
        {
          collection: opts.collection,
          folders,
          request,
          vars: opts.vars,
          baselineVars: { ...runStart, data: opts.vars.data, local: {} },
          iteration: it,
          iterationCount: iterations
        },
        deps,
        { executionId: `${opts.runId}:${it}:${i}`, signal: opts.signal }
      )
      mutations.push(...exec.mutations)
      const passed = !exec.error && exec.scriptErrors.length === 0 && exec.tests.every((t) => t.passed)
      const item: RunItemResult = {
        iteration: it,
        index: i,
        requestId: request.id,
        name: request.name,
        method: exec.request.method,
        url: exec.request.url,
        ...(exec.response ? { status: exec.response.status, timeMs: exec.response.timeMs } : {}),
        tests: exec.tests,
        scriptErrors: exec.scriptErrors,
        ...(exec.error ? { error: exec.error } : {}),
        passed
      }
      results.push(item)
      completed++
      opts.onProgress?.({ completed, total, result: item })
      if (exec.error?.code === 'CANCELLED' || opts.signal?.aborted) {
        stopped = true
        stoppedReason = 'user'
        break outer
      }
      if (!passed && opts.stopOnFailure) {
        stopped = true
        stoppedReason = 'failure'
        break outer
      }
      const last = it === iterations - 1 && i === opts.plan.length - 1
      if (!last && opts.delayMs > 0) await sleep(opts.delayMs, opts.signal)
    }
  }

  const allTests = results.flatMap((r) => r.tests)
  const finished = Date.now()
  return {
    summary: {
      runId: opts.runId,
      collectionId: opts.collection.id,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      iterations,
      totalRequests: results.length,
      failedRequests: results.filter((r) => !r.passed).length,
      totalTests: allTests.length,
      passedTests: allTests.filter((t) => t.passed).length,
      failedTests: allTests.filter((t) => !t.passed).length,
      stopped,
      ...(stoppedReason ? { stoppedReason } : {}),
      results
    },
    mutations,
    vars: opts.vars
  }
}
