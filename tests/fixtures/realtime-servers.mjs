// Local WebSocket and gRPC test servers, shared by vitest (tests/*.test.ts) and the UI end-to-end run
// (e2e/drive.mjs). Independent of Courier's code: `ws` and `@grpc/grpc-js` + `@grpc/proto-loader`
// + `@grpc/reflection` (dev dependency) on the server side. Nothing here leaves 127.0.0.1.
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { ReflectionService } from '@grpc/reflection'
import { ReflectionV1AlphaImplementation } from '@grpc/reflection/build/src/implementations/reflection-v1alpha.js'
import { WebSocketServer } from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
export const PROTO_ROOT = join(here, 'grpc', 'protos')
export const ECHO_PROTO = join(PROTO_ROOT, 'courier', 'test', 'v1', 'echo.proto')

/**
 * WebSocket echo server.
 *  - echoes every text / binary message; records what it received (`received`) and every handshake (`handshakes`)
 *  - subprotocols: picks "courier.v2" when offered
 *  - sets a cookie on the handshake (`Set-Cookie: wscookie=from-handshake`)
 *  - `/reject` answers 403 with a body; `/needs-auth` answers 401 unless an Authorization header is sent
 *  - text commands: `close:<code>:<reason>`, `big:<bytes>`, `ping:<payload>`, `binary:<hex>`
 */
export async function startWsServer({ tls } = {}) {
  const handshakes = []
  const received = []
  const server = tls ? createHttpsServer({ cert: tls.cert, key: tls.key }) : createHttpServer()
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('courier.v2') ? 'courier.v2' : false)
  })
  wss.on('headers', (headers) => headers.push('Set-Cookie: wscookie=from-handshake; Path=/'))
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local')
    handshakes.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers })
    if (url.pathname === '/reject') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nno websockets for you')
      return
    }
    if (url.pathname === '/needs-auth' && !req.headers.authorization) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nmissing credentials')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws, req) => {
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data)
      received.push({ path: new URL(req.url ?? '/', 'http://local').pathname, binary: isBinary, data: buf })
      if (!isBinary) {
        const text = buf.toString('utf8')
        let m
        if ((m = /^close:(\d+):(.*)$/.exec(text))) return ws.close(Number(m[1]), m[2])
        if ((m = /^big:(\d+)$/.exec(text))) return ws.send('x'.repeat(Number(m[1])))
        if ((m = /^ping:(.*)$/.exec(text))) return ws.ping(m[1])
        if ((m = /^binary:([0-9a-f]*)$/.exec(text))) return ws.send(Buffer.from(m[1], 'hex'), { binary: true })
      }
      ws.send(buf, { binary: isBinary })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    url: `${tls ? 'wss' : 'ws'}://127.0.0.1:${port}`,
    port,
    handshakes,
    received,
    clients: () => wss.clients.size,
    stop: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate()
        wss.close()
        server.closeAllConnections?.()
        server.close(() => r())
      })
  }
}

const LOADER = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_ROOT] }

/**
 * gRPC server for courier.test.v1.Echo (see tests/fixtures/grpc/protos).
 * `reflection`: 'both' (v1 + v1alpha, default), 'v1alpha' (v1alpha only) or 'none'.
 * `tls`: { cert, key } PEM buffers (server-side TLS), otherwise plaintext.
 */
export async function startGrpcServer({ tls, reflection = 'both' } = {}) {
  const pkgDef = protoLoader.loadSync(ECHO_PROTO, LOADER)
  const pkg = grpc.loadPackageDefinition(pkgDef)
  const Echo = pkg.courier.test.v1.Echo
  const calls = []
  const server = new grpc.Server()
  const record = (name, call) => calls.push({ name, metadata: call.metadata.getMap() })
  server.addService(Echo.service, {
    Say: (call, cb) => {
      record('Say', call)
      const r = call.request
      cb(null, { text: (r.text || '').repeat(Math.max(1, r.times || 1)), echo: r, at: { seconds: '1700000000', nanos: 5000000 } })
    },
    Metadata: (call, cb) => {
      record('Metadata', call)
      const headers = new grpc.Metadata()
      headers.set('x-server', 'courier-test')
      call.sendMetadata(headers)
      const trailers = new grpc.Metadata()
      trailers.set('x-trailer', 'done')
      const md = {}
      for (const [k, v] of Object.entries(call.metadata.getMap())) md[k] = Buffer.isBuffer(v) ? v.toString('base64') : String(v)
      cb(null, { text: 'metadata', metadata: md }, trailers)
    },
    Count: (call) => {
      record('Count', call)
      const { from, to, delay_ms } = call.request
      let i = from
      const tick = () => {
        if (call.cancelled) return
        if (i > to) return call.end()
        call.write({ value: String(i++) })
        setTimeout(tick, delay_ms || 0)
      }
      tick()
    },
    Sum: (call, cb) => {
      record('Sum', call)
      let total = 0n
      let count = 0
      call.on('data', (n) => {
        total += BigInt(n.value)
        count++
      })
      call.on('end', () => cb(null, { total: String(total), count }))
    },
    Chat: (call) => {
      record('Chat', call)
      call.on('data', (m) => call.write({ text: `echo: ${m.text}`, echo: m }))
      call.on('end', () => call.end())
    },
    Fail: (call, cb) => {
      record('Fail', call)
      cb({ code: call.request.code, details: call.request.message || 'failed on purpose' })
    },
    Slow: (call, cb) => {
      record('Slow', call)
      const t = setTimeout(() => cb(null, {}), call.request.delay_ms || 0)
      call.on('cancelled', () => clearTimeout(t))
    }
  })
  if (reflection === 'both') new ReflectionService(pkgDef).addToServer(server)
  else if (reflection === 'v1alpha') new ReflectionV1AlphaImplementation(pkgDef).addToServer(server)
  const creds = tls ? grpc.ServerCredentials.createSsl(null, [{ cert_chain: tls.cert, private_key: tls.key }], false) : grpc.ServerCredentials.createInsecure()
  const port = await new Promise((res, rej) => server.bindAsync('127.0.0.1:0', creds, (err, p) => (err ? rej(err) : res(p))))
  return {
    address: `127.0.0.1:${port}`,
    port,
    calls,
    stop: () => new Promise((r) => server.tryShutdown(() => r()))
  }
}
