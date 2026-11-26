// Smoke test of the Courier CLI container image (Dockerfile, .github/workflows/container.yml).
//
//   node e2e/container-smoke.mjs <image> [--expect-version <x.y.z>] [--desktop]
//
// Starts an HTTP server on this machine, then runs the image with Docker: --version, --help, a
// passing collection (JUnit report written to the mounted directory as the calling user), a failing
// collection (exit 1) and a missing file (exit 2). The container reaches the server through the host
// network (`--network host`, Linux). With --desktop (Docker Desktop on macOS or Windows, which has no
// usable host network) it uses host.docker.internal instead.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const image = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--expect-version')
const expectIdx = args.indexOf('--expect-version')
const expectVersion = expectIdx >= 0 ? args[expectIdx + 1] : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const desktop = args.includes('--desktop')
if (!image) {
  console.error('usage: node e2e/container-smoke.mjs <image> [--expect-version <x.y.z>] [--desktop]')
  process.exit(2)
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n${detail}`}`)
  if (!ok) failures++
}

const server = createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'up', method: req.method }))
  } else {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://${desktop ? 'host.docker.internal' : '127.0.0.1'}:${port}`

const collection = (name, expected) => ({
  info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    {
      name: 'Health',
      request: { method: 'GET', url: '{{baseUrl}}/ok' },
      event: [
        {
          listen: 'test',
          script: {
            exec: [
              `pm.test('status is ${expected}', () => pm.response.to.have.status(${expected}));`,
              "pm.test('body says up', () => pm.expect(pm.response.json().status).to.eql('up'));"
            ]
          }
        }
      ]
    }
  ]
})

const work = mkdtempSync(join(tmpdir(), 'courier-container-'))
writeFileSync(join(work, 'pass.postman_collection.json'), JSON.stringify(collection('Smoke pass', 200)))
writeFileSync(join(work, 'fail.postman_collection.json'), JSON.stringify(collection('Smoke fail', 201)))

// Runs as the calling user so the report lands in the mounted directory (README, "Container image").
const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : []
const network = desktop ? [] : ['--network', 'host']
// Asynchronous on purpose: the test server runs in this process and must keep answering.
function docker(cliArgs) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['run', '--rm', ...network, ...user, '-v', `${work}:/work`, image, ...cliArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let stdout = ''
    child.stdout.on('data', (d) => {
      out += d
      stdout += d
    })
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('error', (err) => (out += String(err)))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, stdout })
    })
  })
}

try {
  let r = await docker(['--version'])
  check(`--version prints ${expectVersion}`, r.code === 0 && r.stdout.trim() === expectVersion, r.out)

  r = await docker(['--help'])
  check('--help exits 0', r.code === 0 && r.out.includes('Usage: courier run'), r.out)

  r = await docker(['run', '/work/pass.postman_collection.json', '--env-var', `baseUrl=${baseUrl}`, '--no-color', '-r', 'console,junit', '--reporter-junit-export', '/work/out/junit.xml'])
  check('passing collection exits 0', r.code === 0, r.out)
  let junit = ''
  try {
    junit = readFileSync(join(work, 'out', 'junit.xml'), 'utf8')
  } catch {}
  check('JUnit report written to the mounted directory', junit.includes('<testsuites') && junit.includes('status is 200') && !junit.includes('<failure'), junit || r.out)

  r = await docker(['run', '/work/fail.postman_collection.json', '--env-var', `baseUrl=${baseUrl}`, '--no-color'])
  check('failing collection exits 1', r.code === 1 && r.out.includes('status is 201'), `exit ${r.code}\n${r.out}`)

  r = await docker(['run', '/work/missing.json'])
  check('missing collection exits 2', r.code === 2, `exit ${r.code}\n${r.out}`)
} finally {
  server.close()
  rmSync(work, { recursive: true, force: true })
}

console.log(failures ? `${failures} check(s) failed` : 'container smoke test passed')
process.exit(failures ? 1 : 0)
