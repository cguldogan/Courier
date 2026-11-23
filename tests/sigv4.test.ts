/**
 * AWS Signature Version 4.
 *
 * Vectors:
 *  - tests/fixtures/sigv4/*: files from AWS's published SigV4 test suite (aws-sig-v4-test-suite,
 *    credentials AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, us-east-1, service "service"),
 *    as mirrored in https://github.com/mhart/aws4/tree/master/test/aws-sig-v4-test-suite
 *    (fetched 2026-11-23): get-vanilla, get-vanilla-query-order-key-case, get-vanilla-query-unreserved,
 *    get-header-value-trim, post-vanilla-query, post-x-www-form-urlencoded and
 *    post-sts-token/post-sts-header-before (session token signed).
 *  - The S3 examples in the AWS docs "Signature Calculations for the Authorization Header: Transferring
 *    Payload in a Single Chunk" (GET Object, PUT Object) and "Authenticating Requests: Using Query
 *    Parameters" (presigned URL), https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
 *    and .../sigv4-query-string-auth.html (fetched 2026-11-23).
 * Plus a local server that recomputes the signature from what actually arrived on the wire.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CookieJar } from 'tough-cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signV4 } from '../src/main/auth/sigv4'
import { executeRequest } from '../src/main/executor'
import { newRequest } from '../src/shared/types'
import { cleanupTempDirs, echoServer, settings } from './helpers'

const FIX = join(__dirname, 'fixtures/sigv4')
const SUITE_KEY = { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' }
const S3_KEY = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3' }

function parseReq(text: string): { method: string; path: string; headers: [string, string][]; body: string } {
  const [head, ...rest] = text.split('\n\n')
  const lines = head.split('\n')
  const [method, path] = lines[0].split(' ')
  const headers = lines.slice(1).map((l) => {
    const i = l.indexOf(':')
    return [l.slice(0, i), l.slice(i + 1)] as [string, string]
  })
  return { method, path, headers, body: rest.join('\n\n') }
}

describe('AWS SigV4 test suite vectors', () => {
  const cases = ['get-vanilla', 'get-vanilla-query-order-key-case', 'get-vanilla-query-unreserved', 'get-header-value-trim', 'post-vanilla-query', 'post-x-www-form-urlencoded', 'post-sts-header-before']
  for (const name of cases) {
    it(name, () => {
      const read = (ext: string): string => readFileSync(join(FIX, `${name}.${ext}`), 'utf8')
      const req = parseReq(read('req'))
      const host = req.headers.find(([k]) => k.toLowerCase() === 'host')![1]
      const r = signV4({ ...SUITE_KEY, method: req.method, url: `https://${host}${req.path}`, headers: req.headers, body: req.body, date: new Date('2015-08-30T12:36:00Z'), mode: 'header' })
      expect(r.canonicalRequest).toBe(read('creq'))
      expect(r.stringToSign).toBe(read('sts'))
      expect(r.authorization).toBe(read('authz'))
    })
  }
})

describe('AWS S3 documentation examples', () => {
  const date = new Date('2013-05-24T00:00:00Z')
  it('GET Object (header signing, x-amz-content-sha256 of the empty body)', () => {
    const r = signV4({
      ...S3_KEY,
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: [
        ['Range', 'bytes=0-9'],
        ['x-amz-content-sha256', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['x-amz-date', '20130524T000000Z']
      ],
      date,
      mode: 'header'
    })
    expect(r.stringToSign.split('\n').at(-1)).toBe('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972')
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
    expect(r.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date')
  })
  it('PUT Object (path encoded once for S3: $ → %24; payload hash)', () => {
    const r = signV4({
      ...S3_KEY,
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test$file.text',
      headers: [
        ['Date', 'Fri, 24 May 2013 00:00:00 GMT'],
        ['x-amz-date', '20130524T000000Z'],
        ['x-amz-storage-class', 'REDUCED_REDUNDANCY'],
        ['x-amz-content-sha256', '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072']
      ],
      body: 'Welcome to Amazon S3.',
      date,
      mode: 'header'
    })
    expect(r.canonicalRequest.split('\n')[1]).toBe('/test%24file.text')
    expect(r.stringToSign.split('\n').at(-1)).toBe('9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d')
    expect(r.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
  })
  it('presigned URL (query signing, UNSIGNED-PAYLOAD)', () => {
    const r = signV4({ ...S3_KEY, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: [], date, mode: 'query', expiresSeconds: 86400 })
    expect(r.stringToSign.split('\n').at(-1)).toBe('3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04')
    expect(r.url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    )
  })
  it('header signing for s3 adds x-amz-content-sha256 of the body and signs it', () => {
    const r = signV4({ ...S3_KEY, method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/a.txt', headers: [], body: 'hello', date, mode: 'header' })
    const h = Object.fromEntries(r.headers.map(([k, v]) => [k.toLowerCase(), v]))
    expect(h['x-amz-content-sha256']).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(r.authorization).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date,/)
  })
})

describe('canonical path', () => {
  const sign = (url: string, service: string) => signV4({ ...SUITE_KEY, service, method: 'GET', url, headers: [], date: new Date('2015-08-30T12:36:00Z'), mode: 'header' }).canonicalRequest.split('\n')[1]
  it('non-S3 services encode the path as sent once more (reserved characters, existing escapes)', () => {
    // A Lambda-style ARN in the path: ':' goes on the wire raw and is %3A in the canonical request.
    expect(sign('https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:my-fn/invocations', 'lambda')).toBe(
      '/2015-03-31/functions/arn%3Aaws%3Alambda%3Aus-east-1%3A123456789012%3Afunction%3Amy-fn/invocations'
    )
    // An escape on the wire is escaped again.
    expect(sign('https://example.amazonaws.com/a%20b/c', 'service')).toBe('/a%2520b/c')
  })
  it('S3 normalises each segment to a single encoding', () => {
    expect(sign('https://bucket.s3.amazonaws.com/a%20b/x:y', 's3')).toBe('/a%20b/x%3Ay')
  })
})

describe('AWS SigV4 through the executor', () => {
  let srv: Awaited<ReturnType<typeof echoServer>>
  beforeAll(async () => {
    srv = await echoServer()
  })
  afterAll(async () => {
    await srv.close()
    cleanupTempDirs()
  })
  const AWS = { type: 'awsv4' as const, accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'session-T0ken-abc', region: 'eu-west-1', service: 'execute-api' }

  it('signs what goes on the wire (host with port, content-type, body, session token); secrets masked', async () => {
    const jar = new CookieJar()
    await jar.setCookie('c=1; Path=/', srv.url) // the jar's Cookie header is added after signing and must not break it
    const req = newRequest({ method: 'POST', url: `${srv.url}/prod/items?b=2&a=1`, headers: [{ key: 'X-Custom', value: '  spaced   value ', enabled: true }], body: { mode: 'raw', language: 'json', raw: '{"x":1}' }, auth: { ...AWS, addTo: 'header' } })
    const now = new Date('2026-11-23T10:00:00Z')
    const result = await executeRequest({ collection: null, folders: [], request: req, vars: { global: {}, collection: {}, environment: {}, data: {}, local: {} } }, { settings: settings(), cookieJar: jar, now: () => now }, { executionId: 'x' })
    expect(result.response?.status).toBe(200)
    const got = srv.requests.at(-1)!
    expect(got.headers.cookie).toBe('c=1')
    // Recompute from the received request: every signed header as received, same body.
    const auth = String(got.headers.authorization)
    const signedNames = /SignedHeaders=([^,]+)/.exec(auth)![1].split(';')
    expect(signedNames).toEqual(expect.arrayContaining(['host', 'content-type', 'x-amz-date', 'x-amz-security-token', 'x-custom']))
    expect(signedNames).not.toContain('cookie')
    expect(signedNames).not.toContain('user-agent')
    const again = signV4({
      method: got.method,
      url: `http://${got.headers.host}${got.url}`,
      headers: signedNames.map((n) => [n, String(got.headers[n])] as [string, string]),
      body: got.body,
      accessKey: AWS.accessKey,
      secretKey: AWS.secretKey,
      region: 'eu-west-1',
      service: 'execute-api',
      date: now,
      mode: 'header'
    })
    expect(auth).toBe(again.authorization)
    expect(auth).toContain('Credential=AKIDEXAMPLE/20261123/eu-west-1/execute-api/aws4_request')
    // masked in what comes back
    const shown = JSON.stringify(result.request)
    expect(shown).not.toContain(AWS.sessionToken)
  })

  it('query signing presigns the URL; the signature is masked in the request view', async () => {
    const req = newRequest({ url: `${srv.url}/q`, auth: { ...AWS, sessionToken: '', addTo: 'query' } })
    const result = await executeRequest({ collection: null, folders: [], request: req, vars: { global: {}, collection: {}, environment: {}, data: {}, local: {} } }, { settings: settings(), cookieJar: new CookieJar() }, { executionId: 'x' })
    expect(result.response?.status).toBe(200)
    const got = srv.requests.at(-1)!
    const sig = new URL(got.url, 'http://x').searchParams.get('X-Amz-Signature')
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    expect(got.headers.authorization).toBeUndefined()
    expect(result.request.url).not.toContain(sig!)
    expect(result.request.url).toContain('X-Amz-Signature=••••')
  })
})
