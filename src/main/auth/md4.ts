/**
 * MD4 (RFC 1320) in plain TypeScript.
 *
 * NTLM's NT hash is MD4(UTF-16LE(password)). OpenSSL 3 (Node 17+) only offers MD4 through its legacy
 * provider, and Electron's BoringSSL build does not promise it either, so Courier carries this small
 * implementation instead of relying on `crypto.createHash('md4')`. It is only used for NTLM; MD4 is
 * broken as a general-purpose hash. Verified against the RFC 1320 appendix A.5 test suite
 * (tests/ntlm.test.ts).
 */

const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n))

export function md4(input: Uint8Array): Buffer {
  const bitLen = input.length * 8
  // Pad: 0x80, zeros to 56 mod 64, then the 64-bit little-endian bit length.
  const padLen = ((input.length + 8) >> 6) * 64 + 64
  const msg = new Uint8Array(padLen)
  msg.set(input)
  msg[input.length] = 0x80
  const dv = new DataView(msg.buffer)
  dv.setUint32(padLen - 8, bitLen >>> 0, true)
  dv.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000), true)

  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476
  const X = new Array<number>(16)
  const F = (x: number, y: number, z: number): number => (x & y) | (~x & z)
  const G = (x: number, y: number, z: number): number => (x & y) | (x & z) | (y & z)
  const H = (x: number, y: number, z: number): number => x ^ y ^ z

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = dv.getUint32(off + i * 4, true)
    const aa = a
    const bb = b
    const cc = c
    const dd = d
    // Round 1
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + F(b, c, d) + X[i]) | 0, 3)
      d = rotl((d + F(a, b, c) + X[i + 1]) | 0, 7)
      c = rotl((c + F(d, a, b) + X[i + 2]) | 0, 11)
      b = rotl((b + F(c, d, a) + X[i + 3]) | 0, 19)
    }
    // Round 2
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + G(b, c, d) + X[i] + 0x5a827999) | 0, 3)
      d = rotl((d + G(a, b, c) + X[i + 4] + 0x5a827999) | 0, 5)
      c = rotl((c + G(d, a, b) + X[i + 8] + 0x5a827999) | 0, 9)
      b = rotl((b + G(c, d, a) + X[i + 12] + 0x5a827999) | 0, 13)
    }
    // Round 3
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + H(b, c, d) + X[i] + 0x6ed9eba1) | 0, 3)
      d = rotl((d + H(a, b, c) + X[i + 8] + 0x6ed9eba1) | 0, 9)
      c = rotl((c + H(d, a, b) + X[i + 4] + 0x6ed9eba1) | 0, 11)
      b = rotl((b + H(c, d, a) + X[i + 12] + 0x6ed9eba1) | 0, 15)
    }
    a = (a + aa) | 0
    b = (b + bb) | 0
    c = (c + cc) | 0
    d = (d + dd) | 0
  }
  const out = Buffer.alloc(16)
  out.writeInt32LE(a, 0)
  out.writeInt32LE(b, 4)
  out.writeInt32LE(c, 8)
  out.writeInt32LE(d, 12)
  return out
}
