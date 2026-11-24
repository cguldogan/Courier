/**
 * `courier mock <collection>`: serves a collection's saved examples on 127.0.0.1 until Ctrl-C, with
 * the app's matching rules (src/main/mock). Logs one line per request to standard output. Nothing is
 * read from or written to the desktop app's data; Key Vault references are never resolved.
 */
import type { MockLogEntry } from '../shared/api'
import type { Environment } from '../shared/types'
import { MockServer, mockVariables } from '../main/mock/server'
import { mockCandidates } from '../main/mock/match'
import { UsageError, intOption, type CommandSpec, type ParsedCommand } from './args'
import type { CliIO } from './run'
import { collectionFromJson, environmentFromJson, readJsonFile } from './sources'

export const MOCK_SPEC: CommandSpec = {
  name: 'mock',
  brief: 'Serve a collection\'s saved response examples on a local mock server (127.0.0.1) until Ctrl-C.',
  usage: 'mock <collection> [options]',
  summary:
    'Starts a mock HTTP server on 127.0.0.1 that answers with the collection\'s saved response examples, matched by method and path (then the x-mock-response-id / -name / -code headers, query parameters and the most specific path), exactly like the app\'s mock servers. One line per request goes to standard output. Runs until Ctrl-C.',
  positionals: [{ name: '<collection>', description: 'A collection file with saved examples (Courier JSON, or Postman v2.0/v2.1 with response[] examples).' }],
  options: {
    port: { type: 'string', short: 'p', arg: '<n>', description: 'Port on 127.0.0.1 (default 0: any free port; the URL is printed first).' },
    environment: { type: 'string', short: 'e', arg: '<file>', description: 'Environment file whose plain variables are substituted into example bodies and headers.' },
    delay: { type: 'string', arg: '<ms>', description: 'Wait this long before every answer (max 60000).' },
    'no-cors': { type: 'boolean', description: 'Do not send CORS headers or answer CORS preflight requests.' },
    'no-vars': { type: 'boolean', description: 'Serve example bodies as saved, without substituting {{variables}}.' },
    help: { type: 'boolean', short: 'h', description: 'Show this help.' }
  },
  notes: [
    'The server only listens on 127.0.0.1 and only answers requests whose Host is 127.0.0.1:<port> or localhost:<port>. Key Vault references and secret-typed variables are served as ••••, never resolved.',
    'Example:\n  courier mock orders.courier.json --port 4010 -e local.postman_environment.json\n  curl http://127.0.0.1:4010/orders/42 -H "x-mock-response-code: 404"'
  ]
}

export interface MockConfig {
  collection: string
  environment?: string
  port: number
  delayMs: number
  cors: boolean
  substitute: boolean
}

export function mockConfig(p: ParsedCommand): MockConfig {
  if (p.positionals.length !== 1) throw new UsageError(p.positionals.length ? `Expected one collection, got ${p.positionals.length}.` : 'Missing <collection>: a collection file with saved examples.', 'mock')
  const v = p.values
  const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)
  return {
    collection: p.positionals[0],
    ...(str(v.environment) !== undefined ? { environment: str(v.environment) } : {}),
    port: intOption(str(v.port), 'port', 0, 65535) ?? 0,
    delayMs: intOption(str(v.delay), 'delay', 0, 60_000) ?? 0,
    cors: v['no-cors'] !== true,
    substitute: v['no-vars'] !== true
  }
}

function line(e: Omit<MockLogEntry, 'seq'>): string {
  const t = e.at.slice(11, 19)
  const what = e.example ? `"${e.example.name}" (${e.example.request})` : (e.note ?? '')
  return `${t}  ${e.method.padEnd(7)} ${e.path}  → ${e.status}  ${what}  ${e.durationMs} ms\n`
}

/** Runs until `io.signal` aborts (Ctrl-C). Returns the exit code. */
export async function mockCommand(cfg: MockConfig, io: CliIO): Promise<number> {
  const loaded = collectionFromJson(await readJsonFile(cfg.collection, io.cwd, 'Collection'), `Collection file ${cfg.collection}`)
  for (const w of loaded.warnings) io.stderr.write(`courier: warning: ${w}\n`)
  const collection = loaded.doc
  let environment: Environment | null = null
  if (cfg.environment !== undefined) environment = environmentFromJson(await readJsonFile(cfg.environment, io.cwd, 'Environment'), `Environment file ${cfg.environment}`).doc
  const count = mockCandidates(collection).length
  const layers = mockVariables(collection, environment)
  const server = new MockServer({
    port: cfg.port,
    collection: () => collection,
    variables: () => layers,
    settings: () => ({ delayMs: cfg.delayMs, cors: cfg.cors, substituteVariables: cfg.substitute }),
    onLog: (e) => void io.stdout.write(line(e))
  })
  await server.start()
  io.stdout.write(`Mock server for "${collection.name}" listening on ${server.url} (${count} example${count === 1 ? '' : 's'}). Ctrl-C to stop.\n`)
  if (!count) io.stderr.write('courier: warning: the collection has no saved examples; every request gets a 404.\n')
  await new Promise<void>((resolve) => {
    if (io.signal?.aborted) return resolve()
    io.signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  await server.stop()
  io.stdout.write('Mock server stopped.\n')
  return 0
}
