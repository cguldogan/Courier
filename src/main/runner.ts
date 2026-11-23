/**
 * Collection runner (pure Node): ordered requests × iterations (or data rows), delay, stop-on-failure,
 * cancellation, live progress callback and a summary. Variables carry over between requests and
 * iterations; `data` is replaced per iteration; `local` is reset per request.
 *
 * `pm.execution.setNextRequest(nameOrId)` (or `postman.setNextRequest`) jumps, after the current
 * request, to that request of THIS run's plan (id first, then the first request with that name);
 * `null` stops the run; a name that is not in the run stops it with an error. The jump applies within
 * the iteration, as in Postman. A loop guard stops an iteration after `maxJumps` jumps.
 */
import type { Collection, ExecutionResult, Folder, Id, RequestDef, RunItemResult, RunSummary, VariableMutation } from '../shared/types'
import { walkItems } from '../shared/types'
import { Fault } from './errors'
import { executeRequest, type ExecutorDeps } from './executor'
import type { ScriptVars } from './sandbox'

export interface RunPlanItem {
  request: RequestDef
  folders: Folder[]
}

/**
 * Requests to run, in tree order. `folderId` / `folderIds` keep the requests inside any of those
 * folders (still in tree order); `requestIds` then picks and orders requests explicitly.
 */
export function planRun(collection: Collection, opts: { folderId?: Id; folderIds?: Id[]; requestIds?: Id[] }): RunPlanItem[] {
  let all: RunPlanItem[] = []
  for (const { item, parents } of walkItems(collection.items)) if (item.type === 'request') all.push({ request: item, folders: parents })
  const folderIds = [...(opts.folderId ? [opts.folderId] : []), ...(opts.folderIds ?? [])]
  if (folderIds.length) {
    for (const id of folderIds) {
      const exists = [...walkItems(collection.items)].some((e) => e.item.id === id && e.item.type === 'folder')
      if (!exists) throw new Fault('NOT_FOUND', 'Folder not found in collection.')
    }
    const wanted = new Set(folderIds)
    all = all.filter((p) => p.folders.some((f) => wanted.has(f.id)))
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
  /** Loop guard: most `setNextRequest` jumps per iteration (default 1000). */
  maxJumps?: number
  onProgress?: (p: { completed: number; total: number; result: RunItemResult }) => void
  /** Every execution's full (masked) result, before `onProgress` (command-line reporters). */
  onExecution?: (exec: ExecutionResult, result: RunItemResult) => void
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

export const DEFAULT_MAX_JUMPS = 1000

export async function runCollection(opts: RunOptions, deps: ExecutorDeps): Promise<RunOutcome> {
  const started = Date.now()
  const iterations = opts.data && opts.data.length ? opts.data.length : Math.max(1, Math.floor(opts.iterations || 1))
  const total = iterations * opts.plan.length
  const results: RunItemResult[] = []
  const mutations: VariableMutation[] = []
  let stopped = false
  let stoppedReason: RunSummary['stoppedReason']
  let stopMessage: string | undefined
  let completed = 0
  const maxJumps = Math.max(1, Math.floor(opts.maxJumps ?? DEFAULT_MAX_JUMPS))
  // Values before any script of the run: a script must not steer a later request's Key Vault
  // references elsewhere through carried-over variables (see executor.ts).
  const runStart = structuredClone(opts.vars)

  outer: for (let it = 0; it < iterations; it++) {
    opts.vars.data = opts.data && opts.data.length ? { ...opts.data[it] } : {}
    let jumps = 0
    for (let i = 0; i < opts.plan.length; ) {
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
        ...(exec.skipped ? { skipped: true } : {}),
        passed
      }
      results.push(item)
      completed++
      opts.onExecution?.(exec, item)
      opts.onProgress?.({ completed, total: Math.max(total, completed), result: item })
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
      let next = i + 1
      if (exec.nextRequest) {
        const want = exec.nextRequest.value
        if (want === null) {
          stopped = true
          stoppedReason = 'script'
          stopMessage = `Stopped by setNextRequest(null) in "${request.name}".`
          break outer
        }
        let target = opts.plan.findIndex((p) => p.request.id === want)
        if (target < 0) target = opts.plan.findIndex((p) => p.request.name === want)
        if (target < 0) {
          stopped = true
          stoppedReason = 'error'
          stopMessage = `setNextRequest("${want}") in "${request.name}": no request with that name or id in this run.`
          break outer
        }
        if (++jumps > maxJumps) {
          stopped = true
          stoppedReason = 'loop-guard'
          stopMessage = `Stopped after ${maxJumps} setNextRequest jumps in iteration ${it + 1} (loop guard). Raise "Max setNextRequest jumps" if the loop is intended.`
          break outer
        }
        next = target
      }
      const last = it === iterations - 1 && next >= opts.plan.length
      if (!last && opts.delayMs > 0) await sleep(opts.delayMs, opts.signal)
      i = next
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
      ...(stopMessage ? { stopMessage } : {}),
      results
    },
    mutations,
    vars: opts.vars
  }
}
