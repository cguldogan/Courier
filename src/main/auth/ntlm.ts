/**
 * NTLMv2 messages for HTTP authentication (MS-NLMP). Only NTLMv2 is implemented: no LM / NTLMv1
 * fallback (those need DES and are weak), no signing or sealing, no key exchange (HTTP does not use
 * them). The primitives are MD4 (./md4.ts, pure TypeScript) and HMAC-MD5 (Node crypto).
 *
 *   Type 1 NEGOTIATE  → server answers 401 `WWW-Authenticate: NTLM <Type 2 CHALLENGE>`
 *   Type 3 AUTHENTICATE (NTLMv2 response) → server answers with the resource.
 *
 * All three messages must travel on one TCP connection (see executor.ts / http.ts).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { md4 } from './md4'

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1')

export const NTLM_FLAGS = {
  UNICODE: 0x00000001,
  OEM: 0x00000002,
  REQUEST_TARGET: 0x00000004,
  NTLM: 0x00000200,
  ALWAYS_SIGN: 0x00008000,
  EXTENDED_SESSIONSECURITY: 0x00080000,
  TARGET_INFO: 0x00800000,
  NEGOTIATE_128: 0x20000000,
  NEGOTIATE_56: 0x80000000
} as const

const CLIENT_FLAGS =
  NTLM_FLAGS.UNICODE |
  NTLM_FLAGS.OEM |
  NTLM_FLAGS.REQUEST_TARGET |
  NTLM_FLAGS.NTLM |
  NTLM_FLAGS.ALWAYS_SIGN |
  NTLM_FLAGS.EXTENDED_SESSIONSECURITY |
  NTLM_FLAGS.TARGET_INFO |
  NTLM_FLAGS.NEGOTIATE_128 |
  NTLM_FLAGS.NEGOTIATE_56

const hmacMd5 = (key: Buffer, ...data: Buffer[]): Buffer => {
  const h = createHmac('md5', key)
  for (const d of data) h.update(d)
  return h.digest()
}
const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le')

/** NTOWFv1 = MD4(UNICODE(password)) — the "NT hash". */
export function ntHash(password: string): Buffer {
  return md4(utf16(password))
}

/** NTOWFv2 = HMAC_MD5(NTOWFv1(password), UNICODE(Uppercase(user) + domain)) — MS-NLMP 3.3.2. */
export function ntowfv2(password: string, user: string, domain: string): Buffer {
  return hmacMd5(ntHash(password), utf16(user.toUpperCase() + domain))
}

/** Type 1 (NEGOTIATE_MESSAGE) without domain / workstation payloads. */
export function negotiateMessage(): Buffer {
  const b = Buffer.alloc(32)
  SIGNATURE.copy(b, 0)
  b.writeUInt32LE(1, 8)
  b.writeUInt32LE(CLIENT_FLAGS >>> 0, 12)
  // DomainNameFields and WorkstationFields stay zero (offsets 16 and 24).
  return b
}

export interface ChallengeMessage {
  flags: number
  serverChallenge: Buffer
  targetInfo: Buffer
  /** MsvAvTimestamp from the target info, when present (FILETIME, 8 bytes). */
  timestamp?: Buffer
}

/** Parses a Type 2 (CHALLENGE_MESSAGE). Throws on malformed input. */
export function parseChallenge(buf: Buffer): ChallengeMessage {
  if (buf.length < 32 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.readUInt32LE(8) !== 2) throw new Error('not an NTLM challenge message')
  const flags = buf.readUInt32LE(20)
  const serverChallenge = Buffer.from(buf.subarray(24, 32))
  let targetInfo = Buffer.alloc(0)
  if (buf.length >= 48) {
    const len = buf.readUInt16LE(40)
    const off = buf.readUInt32LE(44)
    if (len && off + len <= buf.length) targetInfo = Buffer.from(buf.subarray(off, off + len))
  }
  let timestamp: Buffer | undefined
  for (let p = 0; p + 4 <= targetInfo.length; ) {
    const id = targetInfo.readUInt16LE(p)
    const len = targetInfo.readUInt16LE(p + 2)
    if (id === 0) break
    if (id === 7 && len === 8) timestamp = Buffer.from(targetInfo.subarray(p + 4, p + 12))
    p += 4 + len
  }
  return { flags, serverChallenge, targetInfo, ...(timestamp ? { timestamp } : {}) }
}

/** FILETIME (100 ns ticks since 1601-01-01) as 8 little-endian bytes. */
export function fileTime(ms: number): Buffer {
  const ticks = (BigInt(Math.floor(ms)) + 11644473600000n) * 10000n
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(ticks)
  return b
}

export interface NtlmV2Responses {
  ntProofStr: Buffer
  /** NTProofStr + temp (the NTLMv2_RESPONSE structure). */
  ntChallengeResponse: Buffer
  lmChallengeResponse: Buffer
}

/** MS-NLMP 3.3.2 NTLMv2 responses. `time` = 8-byte FILETIME, `clientChallenge` = 8 random bytes. */
export function ntlmv2Responses(input: {
  password: string
  user: string
  domain: string
  serverChallenge: Buffer
  targetInfo: Buffer
  time: Buffer
  clientChallenge: Buffer
  /** True when the server sent MsvAvTimestamp: LmChallengeResponse is then Z(24). */
  zeroLm?: boolean
}): NtlmV2Responses {
  const key = ntowfv2(input.password, input.user, input.domain)
  const temp = Buffer.concat([
    Buffer.from([0x01, 0x01, 0, 0, 0, 0, 0, 0]),
    input.time,
    input.clientChallenge,
    Buffer.alloc(4),
    input.targetInfo,
    Buffer.alloc(4)
  ])
  const ntProofStr = hmacMd5(key, input.serverChallenge, temp)
  const lm = input.zeroLm ? Buffer.alloc(24) : Buffer.concat([hmacMd5(key, input.serverChallenge, input.clientChallenge), input.clientChallenge])
  return { ntProofStr, ntChallengeResponse: Buffer.concat([ntProofStr, temp]), lmChallengeResponse: lm }
}

/** Type 3 (AUTHENTICATE_MESSAGE): header without Version/MIC, payloads at offset 64. */
export function authenticateMessage(input: {
  challenge: ChallengeMessage
  user: string
  password: string
  domain: string
  workstation: string
  /** Injectable for known-answer tests. */
  time?: Buffer
  clientChallenge?: Buffer
}): Buffer {
  const { challenge } = input
  const responses = ntlmv2Responses({
    password: input.password,
    user: input.user,
    domain: input.domain,
    serverChallenge: challenge.serverChallenge,
    targetInfo: challenge.targetInfo,
    time: input.time ?? challenge.timestamp ?? fileTime(Date.now()),
    clientChallenge: input.clientChallenge ?? randomBytes(8),
    zeroLm: challenge.timestamp !== undefined && input.time === undefined
  })
  const unicode = (challenge.flags & NTLM_FLAGS.UNICODE) !== 0
  const enc = (s: string): Buffer => (unicode ? utf16(s) : Buffer.from(s, 'latin1'))
  const fields = [responses.lmChallengeResponse, responses.ntChallengeResponse, enc(input.domain), enc(input.user), enc(input.workstation), Buffer.alloc(0)]
  const header = Buffer.alloc(64)
  SIGNATURE.copy(header, 0)
  header.writeUInt32LE(3, 8)
  let offset = 64
  // Lm, Nt, Domain, User, Workstation, EncryptedRandomSessionKey security buffers at 12, 20, 28, 36, 44, 52.
  fields.forEach((f, i) => {
    const at = 12 + i * 8
    header.writeUInt16LE(f.length, at)
    header.writeUInt16LE(f.length, at + 2)
    header.writeUInt32LE(offset, at + 4)
    offset += f.length
  })
  // Echo the negotiated flags, minus the ones we do not implement (key exchange, version, sign/seal).
  const flags = (challenge.flags & (CLIENT_FLAGS | NTLM_FLAGS.UNICODE | NTLM_FLAGS.OEM)) >>> 0
  header.writeUInt32LE((unicode ? flags & ~NTLM_FLAGS.OEM : flags) >>> 0, 60)
  return Buffer.concat([header, ...fields])
}

/** Extracts the NTLM token from `WWW-Authenticate` values (`NTLM <base64>`), if any. */
export function challengeFromHeaders(values: string[]): Buffer | null {
  for (const v of values)
    for (const part of v.split(',')) {
      const m = /^\s*NTLM\s+([A-Za-z0-9+/=]+)\s*$/i.exec(part)
      if (m) return Buffer.from(m[1], 'base64')
    }
  return null
}
