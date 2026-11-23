/** Helpers for the command-line runner tests: in-process runs and spawning the built bundle. */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { main } from '../src/cli/main'
import { ID_A } from './helpers'

export const CLI_BIN = resolve(__dirname, '../out/cli/courier.cjs')
export const FAKE_ENV = { COURIER_FAKE_IDENTITY: JSON.stringify(ID_A), COURIER_KV_INSECURE_CHALLENGE: '1' }

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs `courier <argv>` in this process. The env always carries the fake identity unless overridden. */
export async function runCli(argv: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; isTTY?: boolean } = {}): Promise<CliResult> {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    env: { ...FAKE_ENV, ...(opts.env ?? {}) },
    cwd: opts.cwd ?? process.cwd(),
    isTTY: opts.isTTY ?? false
  })
  return { code, stdout, stderr }
}

/** Spawns the BUILT bundle with this Node (arm64 under vitest) and collects its output. */
export function spawnCli(argv: string[], opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<CliResult> {
  return new Promise((done, fail) => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries({ ...process.env, ...(opts.env ?? {}) })) if (v !== undefined) env[k] = v
    const child = spawn(process.execPath, [CLI_BIN, ...argv], { cwd: opts.cwd ?? process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', fail)
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }))
  })
}
