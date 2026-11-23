/**
 * JWT bearer (signed at send time, verified here with Node crypto), Postman import/export of the new
 * auth types, the secret scan and code snippets (no secret or live signature leaks).
 */
import { createHmac, generateKeyPairSync, verify } from 'node:crypto'
import { CookieJar } from 'tough-cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signJwt } from '../src/main/auth/jwt'
import { executeRequest, prepareSnippetRequest } from '../src/main/executor'
import { scanCollection } from '../src/main/secrets-scan'
import { generateSnippet } from '../src/shared/codegen'
import { exportPostmanCollection, importPostmanCollection } from '../src/shared/postman'
import { normalizeCollection, serializeCollection } from '../src/shared/serialize'
import { newCollection, newRequest, type Auth, type JwtAlgorithm, type RequestDef } from '../src/shared/types'
import { cleanupTempDirs, echoServer, settings } from './helpers'

let srv: Awaited<ReturnType<typeof echoServer>>
beforeAll(async () => {
  srv = await echoServer()
})
afterAll(async () => {
  await srv.close()
  cleanupTempDirs()
})

const vars = (environment: Record<string, string> = {}) => ({ global: {}, collection: {}, environment, data: {}, local: {} })
const run = (request: RequestDef, environment: Record<string, string> = {}) =>
  executeRequest({ collection: null, folders: [], request, vars: vars(environment) }, { settings: settings(), cookieJar: new CookieJar() }, { executionId: 'j' })

const b64urlJson = (s: string): Record<string, unknown> => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
const jwt = (over: Partial<Extract<Auth, { type: 'jwt' }>> = {}): Extract<Auth, { type: 'jwt' }> => ({
  type: 'jwt',
  algorithm: 'HS256',
  secret: 'jwt-Secret-For-Tests-0123456789',
  secretBase64: false,
  payload: '{"sub":"{{userId}}","aud":"orders"}',
  header: '{"kid":"k1"}',
  addTo: 'header',
  headerPrefix: 'Bearer',
  queryParamKey: 'token',
  ...over
})

describe('JWT bearer', () => {
  for (const alg of ['HS256', 'HS384', 'HS512'] as JwtAlgorithm[]) {
    it(`${alg}: HMAC signature verifies`, () => {
      const t = signJwt({ algorithm: alg, secret: 'k3y', payload: '{"a":1}' })
      const [h, p, s] = t.split('.')
      expect(b64urlJson(h)).toEqual({ alg, typ: 'JWT' })
      expect(b64urlJson(p)).toEqual({ a: 1 })
      expect(s).toBe(createHmac(`sha${alg.slice(2)}`, 'k3y').update(`${h}.${p}`).digest('base64url'))
    })
  }
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  for (const alg of ['RS256', 'RS384', 'RS512'] as JwtAlgorithm[]) {
    it(`${alg}: RSA signature verifies with the public key`, () => {
      const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
      const [h, p, s] = signJwt({ algorithm: alg, secret: pem, payload: '{"a":1}' }).split('.')
      expect(verify(`sha${alg.slice(2)}`, Buffer.from(`${h}.${p}`), rsa.publicKey, Buffer.from(s, 'base64url'))).toBe(true)
    })
  }
  for (const [alg, curve] of [['ES256', 'prime256v1'], ['ES384', 'secp384r1']] as [JwtAlgorithm, string][]) {
    it(`${alg}: ECDSA (JWS P1363 encoding) verifies with the public key`, () => {
      const ec = generateKeyPairSync('ec', { namedCurve: curve })
      const pem = ec.privateKey.export({ type: 'sec1', format: 'pem' }) as string
      const [h, p, s] = signJwt({ algorithm: alg, secret: pem, payload: '{}' }).split('.')
      expect(Buffer.from(s, 'base64url')).toHaveLength(alg === 'ES256' ? 64 : 96)
      expect(verify(`sha${alg.slice(2)}`, Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true)
    })
  }
  it('rejects a key of the wrong type and invalid JSON with clear errors', () => {
    expect(() => signJwt({ algorithm: 'RS256', secret: 'not a key', payload: '{}' })).toThrow(/not a valid PEM private key/)
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    expect(() => signJwt({ algorithm: 'RS256', secret: ec, payload: '{}' })).toThrow(/needs an RSA private key/)
    expect(() => signJwt({ algorithm: 'HS256', secret: 'x', payload: '{oops' })).toThrow(/payload is not valid JSON/)
  })

  it('send: header with prefix, payload variables resolved, token masked in the request view', async () => {
    const result = await run(newRequest({ url: `${srv.url}/jwt`, auth: jwt() }), { userId: 'u-42' })
    const sent = String(srv.requests.at(-1)!.headers.authorization)
    expect(sent).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    const [h, p, s] = sent.slice(7).split('.')
    expect(b64urlJson(h)).toEqual({ kid: 'k1', alg: 'HS256', typ: 'JWT' })
    expect(b64urlJson(p)).toEqual({ sub: 'u-42', aud: 'orders' })
    expect(s).toBe(createHmac('sha256', 'jwt-Secret-For-Tests-0123456789').update(`${h}.${p}`).digest('base64url'))
    expect(result.request.headers.find(([k]) => k === 'Authorization')?.[1]).toBe('Bearer ••••')
    expect(result.response!.bodyText).not.toContain(sent.slice(7))
  })

  it('send: query parameter, base64 secret', async () => {
    const secret = Buffer.from('raw-bytes-secret').toString('base64')
    await run(newRequest({ url: `${srv.url}/jwtq`, auth: jwt({ addTo: 'query', queryParamKey: 'access_token', secret, secretBase64: true }) }))
    const url = new URL(srv.requests.at(-1)!.url, 'http://x')
    const [h, p, s] = url.searchParams.get('access_token')!.split('.')
    expect(s).toBe(createHmac('sha256', Buffer.from('raw-bytes-secret')).update(`${h}.${p}`).digest('base64url'))
    expect(srv.requests.at(-1)!.headers.authorization).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------------------------

const AUTHS: Record<string, Auth> = {
  codePkce: { type: 'oauth2', grantType: 'authorization_code', authUrl: 'https://login.contoso.test/authorize', accessTokenUrl: 'https://login.contoso.test/token', clientId: 'app-1', clientSecret: '', scope: 'openid orders', audience: 'api://orders', clientAuthentication: 'body', redirectUri: 'http://127.0.0.1:8765/callback', pkce: true, extraParams: 'prompt=consent' },
  codePlain: { type: 'oauth2', grantType: 'authorization_code', authUrl: 'https://login.contoso.test/authorize', accessTokenUrl: 'https://login.contoso.test/token', clientId: 'app-2', clientSecret: '{{vault:kv/app-secret}}', scope: 'orders', audience: '', clientAuthentication: 'header', redirectUri: '', pkce: false, extraParams: '' },
  digest: { type: 'digest', username: 'u', password: '{{digestPw}}' },
  aws: { type: 'awsv4', accessKey: 'AKIDEXAMPLE', secretKey: '{{vault:aws-secret}}', sessionToken: '', region: 'eu-west-1', service: 's3', addTo: 'query' },
  ntlm: { type: 'ntlm', username: 'alice', password: '{{ntlmPw}}', domain: 'CONTOSO', workstation: 'WS1' },
  jwtHs: jwt({ secret: '{{vault:jwt-secret}}', secretBase64: true }),
  jwtRs: jwt({ algorithm: 'RS256', secret: '{{vault:jwt-key}}', addTo: 'query', queryParamKey: 'tok', header: '' })
}

describe('Postman v2.1 import/export of the new auth types', () => {
  const col = newCollection({ name: 'Auth zoo', items: Object.entries(AUTHS).map(([name, auth]) => newRequest({ name, url: 'https://api.example.com/x', auth })) })

  it('exports Postman field names', () => {
    const exported = exportPostmanCollection(col) as { item: { name: string; request: { auth: { type: string } & Record<string, { key: string; value: unknown }[]> } }[] }
    const by = (n: string) => exported.item.find((i) => i.name === n)!.request.auth
    const param = (a: Record<string, unknown>, type: string, key: string): unknown => (a[type] as { key: string; value: unknown }[]).find((p) => p.key === key)?.value
    expect(by('codePkce').type).toBe('oauth2')
    expect(param(by('codePkce'), 'oauth2', 'grant_type')).toBe('authorization_code_with_pkce')
    expect(param(by('codePkce'), 'oauth2', 'challengeAlgorithm')).toBe('S256')
    expect(param(by('codePkce'), 'oauth2', 'redirect_uri')).toBe('http://127.0.0.1:8765/callback')
    expect(param(by('codePlain'), 'oauth2', 'grant_type')).toBe('authorization_code')
    expect(param(by('aws'), 'awsv4', 'addAuthDataToQuery')).toBe(true)
    expect(param(by('ntlm'), 'ntlm', 'domain')).toBe('CONTOSO')
    expect(param(by('jwtHs'), 'jwt', 'isSecretBase64Encoded')).toBe(true)
    expect(param(by('jwtRs'), 'jwt', 'privateKey')).toBe('{{vault:jwt-key}}')
    expect(param(by('jwtRs'), 'jwt', 'addTokenTo')).toBe('queryParam')
    expect(by('digest').type).toBe('digest')
  })

  it('round-trips export → import without loss', () => {
    const exported = JSON.parse(JSON.stringify(exportPostmanCollection(col)))
    const { value, warnings } = importPostmanCollection(exported)
    expect(warnings).toEqual([])
    for (const [name, auth] of Object.entries(AUTHS)) expect((value.items.find((i) => i.name === name) as RequestDef).auth, name).toEqual(auth)
  })

  it('imports a Postman-authored oauth2 authorization code + PKCE block with authRequestParams', () => {
    const pm = {
      info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'r',
          request: {
            method: 'GET',
            url: 'https://api.example.com',
            auth: {
              type: 'oauth2',
              oauth2: [
                { key: 'grant_type', value: 'authorization_code_with_pkce', type: 'string' },
                { key: 'authUrl', value: 'https://idp.example.com/auth', type: 'string' },
                { key: 'accessTokenUrl', value: 'https://idp.example.com/token', type: 'string' },
                { key: 'clientId', value: 'c', type: 'string' },
                { key: 'redirect_uri', value: 'https://oauth.pstmn.io/v1/callback', type: 'string' },
                { key: 'authRequestParams', value: [{ key: 'resource', value: 'r1', enabled: true, send_as: 'request_url' }, { key: 'off', value: 'x', enabled: false }], type: 'any' }
              ]
            }
          }
        }
      ]
    }
    const a = (importPostmanCollection(pm).value.items[0] as RequestDef).auth
    // Postman's hosted callback is not a loopback URI: Courier falls back to its random loopback port.
    expect(a).toMatchObject({ type: 'oauth2', grantType: 'authorization_code', pkce: true, redirectUri: '', extraParams: 'resource=r1', authUrl: 'https://idp.example.com/auth' })
  })

  it('Courier documents keep the exact client-credentials shape and round-trip the new types', () => {
    const cc = newCollection({ name: 'cc', auth: { type: 'oauth2', grantType: 'client_credentials', accessTokenUrl: 'https://t', clientId: 'i', clientSecret: '{{s}}', scope: '', audience: '', clientAuthentication: 'body' } })
    expect(Object.keys(JSON.parse(serializeCollection(cc)).auth)).toEqual(['type', 'grantType', 'accessTokenUrl', 'clientId', 'clientSecret', 'scope', 'audience', 'clientAuthentication'])
    const again = normalizeCollection(JSON.parse(serializeCollection(col)))
    for (const [name, auth] of Object.entries(AUTHS)) expect((again.items.find((i) => i.name === name) as RequestDef).auth, name).toEqual(auth)
  })
})

describe('secret scan of the new auth types', () => {
  it('flags literal secrets, ignores {{var}} and vault references', () => {
    const literal = newCollection({
      name: 'L',
      items: [
        newRequest({ name: 'd', auth: { type: 'digest', username: 'u', password: 'Lit3ral-pw' } }),
        newRequest({ name: 'n', auth: { type: 'ntlm', username: 'u', password: 'Lit3ral-pw', domain: 'D', workstation: '' } }),
        newRequest({ name: 'a', auth: { type: 'awsv4', accessKey: 'AKID', secretKey: 'wJalrXUtnFEMI/LITERAL', sessionToken: 'FQoGZXIvYXdzE-literal', region: 'us-east-1', service: 's3', addTo: 'header' } }),
        newRequest({ name: 'j', auth: jwt({ secret: 'literal-hmac-secret' }) }),
        newRequest({ name: 'o', auth: AUTHS.codePkce }),
        newRequest({ name: 'o2', auth: { ...(AUTHS.codePlain as object), clientSecret: 'cs-literal' } as Auth })
      ]
    })
    expect(scanCollection(literal).map((f) => f.field).sort()).toEqual(['awsv4.secretKey', 'awsv4.sessionToken', 'digest.password', 'jwt.secret', 'ntlm.password', 'oauth2.clientSecret'])
    const templated = newCollection({ name: 'T', items: Object.entries(AUTHS).map(([name, auth]) => newRequest({ name, auth })) })
    expect(scanCollection(templated)).toEqual([])
  })
})

describe('code snippets never contain the secrets or a live signature', () => {
  const literal: Record<string, Auth> = {
    digest: { type: 'digest', username: 'u', password: 'Snip-pw-1' },
    ntlm: { type: 'ntlm', username: 'u', password: 'Snip-pw-2', domain: 'D', workstation: '' },
    aws: { type: 'awsv4', accessKey: 'AKIDSNIP', secretKey: 'Snip-secret-3', sessionToken: 'Snip-session-4', region: 'us-east-1', service: 's3', addTo: 'header' },
    awsq: { type: 'awsv4', accessKey: 'AKIDSNIP', secretKey: 'Snip-secret-3', sessionToken: '', region: 'us-east-1', service: 's3', addTo: 'query' },
    jwt: jwt({ secret: 'Snip-secret-5', payload: '{}' }),
    code: { ...(AUTHS.codePlain as object), clientSecret: 'Snip-secret-6' } as Auth
  }
  for (const [name, auth] of Object.entries(literal)) {
    it(name, async () => {
      const req = await prepareSnippetRequest({ collection: null, folders: [], request: newRequest({ url: 'https://api.example.com/x', auth }), vars: vars() })
      for (const lang of ['curl', 'js-fetch', 'python-requests'] as const) {
        const code = generateSnippet(req, lang)
        expect(code).not.toMatch(/Snip-(pw|secret|session)/)
        expect(code).not.toMatch(/[0-9a-f]{64}/)
      }
    })
  }
})
