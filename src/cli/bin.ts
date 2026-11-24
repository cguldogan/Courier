/**
 * Entry point of the bundled `courier` command (out/cli/courier.cjs). Runs in plain Node, or in the
 * Electron binary with ELECTRON_RUN_AS_NODE=1; never imports Electron.
 */
import { main } from './main'

const ac = new AbortController()
let interrupted = false
const command = process.argv[2]
const stop = (): void => {
  if (interrupted) process.exit(130)
  interrupted = true
  // `courier mock` stops at once; a run finishes the request in flight.
  if (command !== 'mock') process.stderr.write('\ncourier: interrupted, finishing the current request (Ctrl-C again to quit now)\n')
  ac.abort()
}
process.on('SIGINT', stop)
// `courier mock` also stops cleanly on SIGTERM (e.g. a service manager or a test harness).
if (command === 'mock') process.on('SIGTERM', stop)

main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  isTTY: process.stdout.isTTY === true,
  signal: ac.signal
}).then(
  (code) => {
    // Keep-alive sockets would keep the process alive: exit explicitly, once the output is flushed.
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
  },
  (err: unknown) => {
    process.stderr.write(`courier: error [INTERNAL]: ${err instanceof Error ? err.message : String(err)}\n`, () => process.exit(2))
  }
)
