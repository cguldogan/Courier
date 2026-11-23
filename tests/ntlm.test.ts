/**
 * NTLM: MD4 (pure TypeScript) and NTLMv2 against published known-answer vectors, then the
 * three-message handshake against a local server that keys handshake state BY SOCKET (as IIS does)
 * and refuses a Type 3 that arrives on a different connection.
 *
 * Vectors:
 *  - MD4: RFC 1320 appendix A.5 test suite, https://www.rfc-editor.org/rfc/rfc1320.txt
 *  - NTLMv2: [MS-NLMP] section 4.2 "Cryptographic Values for Validation": 4.2.1 common values,
 *    4.2.2.1.2 NTOWFv1, 4.2.4.1.1 NTOWFv2, 4.2.4.1.3 temp, 4.2.4.2.1 LMv2 response, 4.2.4.2.2 NTLMv2
 *    response and the 4.2.4.3 CHALLENGE_MESSAGE bytes,
 *    https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nlmp/b90e03d4-66b6-4f1f-bdad-625d6bdb0fda
 *    (fetched 2026-11-23).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { CookieJar } from 'tough-cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { md4 } from '../src/main/auth/md4'
import { authenticateMessage, negotiateMessage, ntHash, ntlmv2Responses, ntowfv2, parseChallenge } from '../src/main/auth/ntlm'
import { executeRequest } from '../src/main/executor'
import { sendHttp } from '../src/main/http'
import { newRequest, type RequestDef } from '../src/shared/types'
import { listen, readBody, settings, type Listening } from './helpers'

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex')

describe('MD4 (RFC 1320 A.5)', () => {
  const suite: [string, string][] = [
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '043f8582f241db351ce627e153e7f0e4'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', 'e33b4ddc9c38f2199c3e7b164fcc0536']
  ]
  for (const [input, digest] of suite) it(`MD4("${input.slice(0, 20)}${input.length > 20 ? '…' : ''}")`, () => expect(md4(Buffer.from(input, 'latin1')).toString('hex')).toBe(digest))
})

describe('NTLMv2 (MS-NLMP 4.2.4 known answers)', () => {
  // 4.2.4.3 CHALLENGE_MESSAGE (target info: MsvAvNbDomainName "Domain", MsvAvNbComputerName "Server").
  const CHALLENGE = hex(`
    4e544c4d53535000 02000000 0c000c00 38000000 33828ae2 0123456789abcdef 0000000000000000 24002400 44000000
    0600701700 00000f 530065007200760065007200 02000c0044006f006d00610069006e00 01000c00530065007200760065007200 00000000`)
  const TIME = Buffer.alloc(8)
  const CLIENT_CHALLENGE = Buffer.alloc(8, 0xaa)

  it('NTOWFv1 (4.2.2.1.2) and NTOWFv2 (4.2.4.1.1)', () => {
    expect(ntHash('Password').toString('hex')).toBe('a4f49c406510bdcab6824ee7c30fd852')
    expect(ntowfv2('Password', 'User', 'Domain').toString('hex')).toBe('0c868a403bfd7a93a3001ef22ef02e3f')
  })

  it('parses the challenge and computes temp, the LMv2 response (4.2.4.2.1) and NTProofStr (4.2.4.2.2)', () => {
    const ch = parseChallenge(CHALLENGE)
    expect(ch.serverChallenge.toString('hex')).toBe('0123456789abcdef')
    expect(ch.flags >>> 0).toBe(0xe28a8233)
    const r = ntlmv2Responses({ password: 'Password', user: 'User', domain: 'Domain', serverChallenge: ch.serverChallenge, targetInfo: ch.targetInfo, time: TIME, clientChallenge: CLIENT_CHALLENGE })
    expect(r.lmChallengeResponse.toString('hex')).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa')
    expect(r.ntProofStr.toString('hex')).toBe('68cd0ab851e51c96aabc927bebef6a1c')
    // 4.2.4.1.3 temp
    expect(r.ntChallengeResponse.subarray(16).toString('hex')).toBe(
      '0101000000000000' + '0000000000000000' + 'aaaaaaaaaaaaaaaa' + '00000000' + '02000c0044006f006d00610069006e00' + '01000c00530065007200760065007200' + '00000000' + '00000000'
    )
  })

  it('AUTHENTICATE_MESSAGE carries those responses, domain, user and workstation', () => {
    const msg = authenticateMessage({ challenge: parseChallenge(CHALLENGE), user: 'User', password: 'Password', domain: 'Domain', workstation: 'COMPUTER', time: TIME, clientChallenge: CLIENT_CHALLENGE })
    const field = (at: number): Buffer => msg.subarray(msg.readUInt32LE(at + 4), msg.readUInt32LE(at + 4) + msg.readUInt16LE(at))
    expect(msg.subarray(0, 12).toString('hex')).toBe('4e544c4d5353500003000000')
    expect(field(12).toString('hex')).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa')
    expect(field(20).subarray(0, 16).toString('hex')).toBe('68cd0ab851e51c96aabc927bebef6a1c')
    expect(field(28).toString('utf16le')).toBe('Domain')
    expect(field(36).toString('utf16le')).toBe('User')
    expect(field(44).toString('utf16le')).toBe('COMPUTER')
  })

  it('NEGOTIATE_MESSAGE is a well-formed Type 1', () => {
    const t1 = negotiateMessage()
    expect(t1.subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0')
    expect(t1.readUInt32LE(8)).toBe(1)
  })
})

// -----------------------------------------------------------------------------------------------
// A local NTLM server: state per socket, like IIS.
// -----------------------------------------------------------------------------------------------

const USER = 'alice'
const DOMAIN = 'CONTOSO'
const PASSWORD = 'Ntlm-Pa55w0rd!'

interface SockState {
  id: number
  challenge?: Buffer
  authed?: boolean
}

let server: Listening
const log: { socket: number; leg: string; status: number }[] = []
let sockSeq = 0
const states = new WeakMap<Socket, SockState>()

function ntlmHandler(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  let st = states.get(req.socket)
  if (!st) {
    st = { id: ++sockSeq }
    states.set(req.socket, st)
  }
  const reply = (status: number, leg: string, headers: Record<string, string> = {}, text = ''): void => {
    log.push({ socket: st.id, leg, status })
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(text)
  }
  if (req.url === '/open') return reply(200, 'open', {}, '{}')
  const auth = req.headers.authorization ?? ''
  const m = /^NTLM (.+)$/.exec(auth)
  if (!m) return reply(401, 'anon', { 'www-authenticate': 'NTLM' })
  const msg = Buffer.from(m[1], 'base64')
  const type = msg.readUInt32LE(8)
  if (type === 1) {
    const challenge = randomBytes(8)
    st.challenge = challenge
    // Target info: NbDomainName + NbComputerName + EOL.
    const av = (id: number, s: string): Buffer => {
      const v = Buffer.from(s, 'utf16le')
      const h = Buffer.alloc(4)
      h.writeUInt16LE(id, 0)
      h.writeUInt16LE(v.length, 2)
      return Buffer.concat([h, v])
    }
    const ti = Buffer.concat([av(2, DOMAIN), av(1, 'SERVER'), Buffer.alloc(4)])
    const t2 = Buffer.alloc(48)
    t2.write('NTLMSSP\0', 0, 'latin1')
    t2.writeUInt32LE(2, 8)
    t2.writeUInt32LE(0xe28a8235, 20)
    challenge.copy(t2, 24)
    t2.writeUInt16LE(ti.length, 40)
    t2.writeUInt16LE(ti.length, 42)
    t2.writeUInt32LE(48, 44)
    return reply(401, 'type1', { 'www-authenticate': `NTLM ${Buffer.concat([t2, ti]).toString('base64')}` })
  }
  if (type === 3) {
    if (!st.challenge) return reply(401, 'type3-wrong-socket', { 'www-authenticate': 'NTLM' })
    const field = (at: number): Buffer => msg.subarray(msg.readUInt32LE(at + 4), msg.readUInt32LE(at + 4) + msg.readUInt16LE(at))
    const nt = field(20)
    const user = field(36).toString('utf16le')
    const domain = field(28).toString('utf16le')
    // Verify the NTLMv2 proof with the server's own copy of the password.
    const key = createHmac('md5', ntHash(PASSWORD)).update(Buffer.from(user.toUpperCase() + domain, 'utf16le')).digest()
    const proof = createHmac('md5', key).update(Buffer.concat([st.challenge, nt.subarray(16)])).digest()
    if (!proof.equals(nt.subarray(0, 16))) return reply(401, 'type3-bad', { 'www-authenticate': 'NTLM' })
    st.authed = true
    return reply(200, 'type3-ok', {}, JSON.stringify({ user: `${domain}\\${user}`, method: req.method, body: body.toString('utf8') }))
  }
  reply(400, 'bad')
}

beforeAll(async () => {
  const s = createServer(async (req, res) => ntlmHandler(req, res, await readBody(req)))
  s.keepAliveTimeout = 10_000
  server = await listen(s)
})
afterAll(async () => {
  await server.close()
})

const vars = () => ({ global: {}, collection: {}, environment: {}, data: {}, local: {} })
const run = (request: RequestDef) => executeRequest({ collection: null, folders: [], request, vars: vars() }, { settings: settings(), cookieJar: new CookieJar() }, { executionId: 'n' })

describe('NTLM handshake against a local server', () => {
  it('authenticates with all three messages on one socket, even with a warm shared connection pool', async () => {
    // Warm the shared pool with several parallel keep-alive connections to the same origin.
    await Promise.all(Array.from({ length: 6 }, () => sendHttp({ method: 'GET', url: `${server.url}/open`, headers: [] }, { followRedirects: false, maxRedirects: 0, verifyTls: true, timeoutMs: 5000, maxResponseBytes: 1e6 })))
    log.length = 0
    const result = await run(newRequest({ method: 'POST', url: `${server.url}/secure`, body: { mode: 'raw', language: 'text', raw: 'payload' }, auth: { type: 'ntlm', username: USER, password: PASSWORD, domain: DOMAIN, workstation: 'WS1' } }))
    expect(result.response?.status).toBe(200)
    expect(JSON.parse(result.response!.bodyText)).toEqual({ user: 'CONTOSO\\alice', method: 'POST', body: 'payload' })
    expect(log.map((l) => l.leg)).toEqual(['type1', 'type3-ok'])
    expect(log[0].socket).toBe(log[1].socket)
    // The Type 3 value is masked in what comes back.
    const sentAuth = result.request.headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1]
    expect(sentAuth).toBe('••••')
  })

  it('accepts DOMAIN\\user in the username field', async () => {
    log.length = 0
    const result = await run(newRequest({ url: `${server.url}/secure`, auth: { type: 'ntlm', username: `${DOMAIN}\\${USER}`, password: PASSWORD, domain: '', workstation: '' } }))
    expect(result.response?.status).toBe(200)
    expect(JSON.parse(result.response!.bodyText).user).toBe('CONTOSO\\alice')
  })

  it('a wrong password ends with the server 401, still on one socket', async () => {
    log.length = 0
    const result = await run(newRequest({ url: `${server.url}/secure`, auth: { type: 'ntlm', username: USER, password: 'wrong', domain: DOMAIN, workstation: '' } }))
    expect(result.response?.status).toBe(401)
    expect(log.map((l) => l.leg)).toEqual(['type1', 'type3-bad'])
    expect(log[0].socket).toBe(log[1].socket)
  })

  it('the server really requires one socket: a Type 3 on a fresh connection is refused', async () => {
    // Build a valid Type 3 for a challenge obtained on another connection.
    const r1 = await sendHttp({ method: 'GET', url: `${server.url}/secure`, headers: [['Authorization', `NTLM ${negotiateMessage().toString('base64')}`], ['Connection', 'close']] }, { followRedirects: false, maxRedirects: 0, verifyTls: true, timeoutMs: 5000, maxResponseBytes: 1e6 })
    const t2 = Buffer.from(r1.headers.find(([k]) => k === 'www-authenticate')![1].slice(5), 'base64')
    const t3 = authenticateMessage({ challenge: parseChallenge(t2), user: USER, password: PASSWORD, domain: DOMAIN, workstation: '' })
    log.length = 0
    const r3 = await sendHttp({ method: 'GET', url: `${server.url}/secure`, headers: [['Authorization', `NTLM ${t3.toString('base64')}`], ['Connection', 'close']] }, { followRedirects: false, maxRedirects: 0, verifyTls: true, timeoutMs: 5000, maxResponseBytes: 1e6 })
    expect(r3.status).toBe(401)
    expect(log[0].leg).toBe('type3-wrong-socket')
  })
})
