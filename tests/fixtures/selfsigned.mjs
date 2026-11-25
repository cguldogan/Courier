// A throw-away self-signed X.509 certificate for 127.0.0.1 / localhost, made with node:crypto only.
// Replaces `openssl req -x509 …` in the test and e2e setup so they need no openssl binary (Windows and
// arm64 runners do not always have one on PATH). Same shape as that command's output: v3, RSA 2048,
// sha256WithRSAEncryption, CN=127.0.0.1, basicConstraints CA:TRUE, subject/authority key identifiers
// and subjectAltName IP:127.0.0.1 (+ DNS:localhost unless `dns: false`). Shared by vitest and e2e.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const len = (n) => {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}
const seq = (...parts) => tlv(0x30, ...parts)
const set = (...parts) => tlv(0x31, ...parts)
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const out = [a * 40 + b]
  for (const n of rest) {
    const chunk = [n & 0x7f]
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f))
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf)
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))
const octets = (buf) => tlv(0x04, buf)
const bits = (buf) => tlv(0x03, Buffer.from([0]), buf)
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]))
const explicit = (n, inner) => tlv(0xa0 + n, inner)
const utcTime = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'))
const ext = (id, value) => seq(oid(id), octets(value))

/** Returns { certPem, keyPem } for a fresh self-signed certificate valid for `days` (default 2). */
export function selfSignedCert({ days = 2, dns = true } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  // Key identifier: SHA-1 of the subjectPublicKey BIT STRING contents (RFC 5280 4.2.1.2 method 1).
  // The SPKI is SEQUENCE { AlgorithmIdentifier, BIT STRING }: skip to the BIT STRING value.
  const keyId = createHash('sha1').update(spkiPublicKeyBits(spki)).digest()
  const name = seq(set(seq(oid('2.5.4.3'), utf8('127.0.0.1'))))
  const sha256Rsa = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]))
  const now = Date.now()
  // Positive and minimal DER: top bit clear (no sign padding needed) and first byte non-zero (a
  // leading 0x00 would be redundant padding, which OpenSSL and BoringSSL reject).
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 0x01
  const san = seq(tlv(0x87, Buffer.from([127, 0, 0, 1])), ...(dns ? [tlv(0x82, Buffer.from('localhost', 'ascii'))] : []))
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(serial),
    sha256Rsa,
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + days * 86_400_000))),
    name,
    spki,
    explicit(3, seq(
      ext('2.5.29.14', octets(keyId)),
      ext('2.5.29.35', seq(tlv(0x80, keyId))),
      seq(oid('2.5.29.19'), bool(true), octets(seq(bool(true)))),
      ext('2.5.29.17', san)
    ))
  )
  const signature = sign('sha256', tbs, privateKey)
  const der = seq(tbs, sha256Rsa, bits(signature))
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

/** Writes a fresh certificate and key (PEM) to the given paths. */
export function writeSelfSignedCert(certPath, keyPath, opts) {
  const { certPem, keyPem } = selfSignedCert(opts)
  writeFileSync(certPath, certPem)
  writeFileSync(keyPath, keyPem, { mode: 0o600 })
}

// DER walk: SEQUENCE header, then the AlgorithmIdentifier TLV, then the BIT STRING (minus its unused-bits byte).
function spkiPublicKeyBits(spki) {
  const header = (buf, at) => {
    const first = buf[at + 1]
    if (first < 0x80) return { body: at + 2, length: first }
    const n = first & 0x7f
    let length = 0
    for (let i = 0; i < n; i++) length = length * 256 + buf[at + 2 + i]
    return { body: at + 2 + n, length }
  }
  const outer = header(spki, 0)
  const alg = header(spki, outer.body)
  const bitString = header(spki, alg.body + alg.length)
  return spki.subarray(bitString.body + 1, bitString.body + bitString.length)
}
