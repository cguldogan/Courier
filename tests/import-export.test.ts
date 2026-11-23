import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportPostmanCollection, exportPostmanEnvironment, importPostmanCollection, importPostmanEnvironment } from '../src/shared/postman'
import { parseCurl, tokenizeShell } from '../src/shared/curl'
import { importOpenApi } from '../src/shared/openapi'
import { generateSnippet } from '../src/shared/codegen'
import { parseCsv, parseDataFile } from '../src/shared/datafile'
import type { Collection, Folder, Item, RequestDef } from '../src/shared/types'

const sample = JSON.parse(readFileSync(join(__dirname, 'fixtures/postman-sample.postman_collection.json'), 'utf8'))

function stripIds(c: Collection): unknown {
  const items = (list: Item[]): unknown[] => list.map((i) => (i.type === 'folder' ? { ...i, id: '', items: items(i.items) } : { ...i, id: '' }))
  return { ...c, id: '', items: items(c.items) }
}
const folder = (c: Collection | Folder, name: string): Folder => c.items.find((i) => i.name === name && i.type === 'folder') as Folder
const req = (c: Collection | Folder, name: string): RequestDef => c.items.find((i) => i.name === name && i.type === 'request') as RequestDef

describe('Postman v2.1 collection', () => {
  const { value: col, warnings } = importPostmanCollection(sample)

  it('imports folders, auth inheritance, scripts, variables and every body mode', () => {
    expect(col.name).toBe('Contoso Orders API')
    expect(col.auth).toEqual({ type: 'bearer', token: '{{accessToken}}' })
    expect(col.preRequestScript).toContain("pm.variables.set('requestId'")
    expect(col.testScript.split('\n')).toHaveLength(3)
    expect(col.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.contoso.test/v1', enabled: true, type: 'default' },
      { key: 'accessToken', value: '', enabled: true, type: 'secret' },
      { key: 'pageSize', value: '25', enabled: false, type: 'default' }
    ])

    const orders = folder(col, 'Orders')
    expect(orders.auth).toEqual({ type: 'apikey', key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' })
    expect(orders.preRequestScript).toBe("console.log('folder pre');")

    const list = req(orders, 'List orders')
    expect(list.auth).toEqual({ type: 'inherit' })
    expect(list.url).toBe('{{baseUrl}}/orders')
    expect(list.params).toEqual([
      { key: 'status', value: 'open', enabled: true },
      { key: 'limit', value: '{{pageSize}}', enabled: true },
      { key: 'debug', value: 'true', enabled: false }
    ])
    expect(list.headers[1]).toEqual({ key: 'X-Debug', value: '1', enabled: false })
    expect(list.testScript).toContain('to.have.status(200)')

    const get = req(orders, 'Get order')
    expect(get.url).toBe('{{baseUrl}}/orders/:orderId')
    expect(get.pathVariables).toEqual([{ key: 'orderId', value: '42', enabled: true, description: 'Order id' }])

    const create = req(orders, 'Create order')
    expect(create.auth).toEqual({ type: 'none' })
    expect(create.body).toEqual({ mode: 'raw', language: 'json', raw: '{\n  "sku": "ABC-1",\n  "qty": 2\n}' })
    expect(create.description).toBe('Creates an order')

    const upload = req(folder(orders, 'Nested'), 'Upload invoice')
    expect(upload.auth).toEqual({ type: 'basic', username: 'svc', password: '{{svcPassword}}' })
    expect(upload.body).toEqual({
      mode: 'formdata',
      formdata: [
        { key: 'orderId', value: '42', enabled: true, kind: 'text' },
        { key: 'file', value: '', enabled: true, kind: 'file', filePath: '/tmp/invoice.pdf' },
        { key: 'note', value: 'skip', enabled: false, kind: 'text' }
      ]
    })

    const auth = folder(col, 'Auth')
    expect(req(auth, 'Token (form)').body).toEqual({
      mode: 'urlencoded',
      urlencoded: [
        { key: 'grant_type', value: 'client_credentials', enabled: true },
        { key: 'scope', value: 'orders.read', enabled: true }
      ]
    })
    expect(req(auth, 'Client credentials').auth).toEqual({
      type: 'oauth2',
      grantType: 'client_credentials',
      accessTokenUrl: 'https://login.contoso.test/oauth/token',
      clientId: '{{clientId}}',
      clientSecret: '{{clientSecret}}',
      scope: 'orders.read',
      audience: '',
      clientAuthentication: 'body'
    })
    expect(req(col, 'GraphQL search').body).toEqual({ mode: 'graphql', graphql: { query: 'query { orders(first: 5) { id } }', variables: '{"first":5}' } })
    expect(req(col, 'Upload raw file').body).toEqual({ mode: 'binary', filePath: '/tmp/blob.bin' })
    expect(req(col, 'Legacy digest').auth).toEqual({ type: 'inherit' })
    expect(warnings.some((w) => w.includes('digest'))).toBe(true)
  })

  it('round-trips import → export → import without loss', () => {
    const exported = exportPostmanCollection(col)
    expect((exported.info as { schema: string }).schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json')
    const listUrl = ((exported.item as { item: { request: { url: { raw: string; query: unknown[] } } }[] }[])[0].item[0].request.url)
    expect(listUrl.raw).toBe('{{baseUrl}}/orders?status=open&limit={{pageSize}}')
    expect(listUrl.query).toHaveLength(3)
    const again = importPostmanCollection(JSON.parse(JSON.stringify(exported))).value
    expect(stripIds(again)).toEqual(stripIds(col))
    // a second export is identical (stable)
    expect(exportPostmanCollection(again)).toEqual({ ...exported, info: { ...(exported.info as object), _postman_id: again.id } })
  })

  it('round-trips the Courier-only entra auth and vault variables through Postman', () => {
    const c: Collection = { ...col, auth: { type: 'entra', scope: 'https://graph.microsoft.com/.default' }, variables: [{ key: 'k', value: 'kv/api-key', enabled: true, type: 'vault' }] }
    const back = importPostmanCollection(exportPostmanCollection(c)).value
    expect(back.auth).toEqual({ type: 'entra', scope: 'https://graph.microsoft.com/.default' })
    expect(back.variables[0].value).toBe('{{vault:kv/api-key}}')
  })
})

describe('Postman environment', () => {
  it('imports and exports, never exporting secret values', () => {
    const { value } = importPostmanEnvironment({
      id: 'x',
      name: 'Staging',
      values: [
        { key: 'baseUrl', value: 'https://staging', type: 'default', enabled: true },
        { key: 'password', value: 'hunter2', type: 'secret', enabled: true },
        { key: 'off', value: '1', enabled: false }
      ],
      _postman_variable_scope: 'environment'
    })
    expect(value.name).toBe('Staging')
    expect(value.variables.map((v) => [v.key, v.type, v.enabled])).toEqual([
      ['baseUrl', 'default', true],
      ['password', 'secret', true],
      ['off', 'default', false]
    ])
    const out = exportPostmanEnvironment(value) as { values: { key: string; value: string; type: string }[] }
    expect(out.values.find((v) => v.key === 'password')).toEqual({ key: 'password', value: '', type: 'secret', enabled: true })
    expect(importPostmanEnvironment(out).value.variables.map((v) => v.key)).toEqual(['baseUrl', 'password', 'off'])
  })
})

describe('cURL import', () => {
  it('tokenizes quotes, escapes and line continuations', () => {
    expect(tokenizeShell(`curl -H 'A: b c' "x\\"y" a\\ b \\\n --data $'l1\\nl2'`)).toEqual(['curl', '-H', 'A: b c', 'x"y', 'a b', '--data', 'l1\nl2'])
  })
  it('parses a JSON POST with headers, bearer, insecure and redirects', () => {
    const { request } = parseCurl(`curl -sSL -k -X POST 'https://api.test/v1/items?x=1' \\
      -H 'Content-Type: application/json' -H "Authorization: Bearer abc.def" \\
      --data-raw '{"name":"widget"}'`)
    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://api.test/v1/items')
    expect(request.params).toEqual([{ key: 'x', value: '1', enabled: true }])
    expect(request.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }])
    expect(request.auth).toEqual({ type: 'bearer', token: 'abc.def' })
    expect(request.body).toEqual({ mode: 'raw', raw: '{"name":"widget"}', language: 'json' })
    expect(request.settings).toEqual({ verifyTls: false, followRedirects: true })
  })
  it('parses form fields, files, basic auth and -G', () => {
    const form = parseCurl(`curl https://up.test/f -u me:pw -F 'a=1' -F 'doc=@/tmp/x.pdf;type=application/pdf'`).request
    expect(form.method).toBe('POST')
    expect(form.auth).toEqual({ type: 'basic', username: 'me', password: 'pw' })
    expect(form.body).toEqual({
      mode: 'formdata',
      formdata: [
        { key: 'a', value: '1', enabled: true, kind: 'text' },
        { key: 'doc', value: '', enabled: true, kind: 'file', filePath: '/tmp/x.pdf', contentType: 'application/pdf' }
      ]
    })
    const urlenc = parseCurl(`curl https://x.test/login -d user=a -d 'pass=b c'`).request
    expect(urlenc.body).toEqual({ mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'a', enabled: true }, { key: 'pass', value: 'b c', enabled: true }] })
    const get = parseCurl(`curl -G https://x.test/s --data-urlencode 'q=hello world'`).request
    expect(get.method).toBe('GET')
    const head = parseCurl('curl -I --url https://x.test').request
    expect(head.method).toBe('HEAD')
    expect(() => parseCurl('wget x')).toThrow()
  })
})

describe('OpenAPI 3 import', () => {
  it('imports servers, tags, params, bodies and security from YAML', () => {
    const yaml = `
openapi: 3.0.3
info: { title: Pets, version: '1' }
servers: [{ url: 'https://{env}.pets.test/api', variables: { env: { default: prod } } }]
security: [{ bearerAuth: [] }]
components:
  securitySchemes: { bearerAuth: { type: http, scheme: bearer } }
  schemas:
    Pet: { type: object, properties: { name: { type: string, example: Rex }, age: { type: integer } } }
paths:
  /pets/{petId}:
    parameters: [{ name: petId, in: path, required: true, schema: { type: string } }]
    get:
      tags: [pets]
      summary: Get pet
      parameters: [{ name: verbose, in: query, schema: { type: boolean } }, { name: X-Trace, in: header, required: true, schema: { type: string } }]
  /pets:
    post:
      tags: [pets]
      operationId: createPet
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
  /health:
    get: { summary: Health, security: [] }
`
    const { value } = importOpenApi(yaml)
    expect(value.name).toBe('Pets')
    expect(value.variables[0]).toEqual({ key: 'baseUrl', value: 'https://prod.pets.test/api', enabled: true, type: 'default' })
    expect(value.auth).toEqual({ type: 'bearer', token: '{{bearerToken}}' })
    const pets = folder(value, 'pets')
    const get = req(pets, 'Get pet')
    expect(get.url).toBe('{{baseUrl}}/pets/:petId')
    expect(get.pathVariables.map((p) => p.key)).toEqual(['petId'])
    expect(get.params).toEqual([{ key: 'verbose', value: 'true', enabled: false }])
    expect(get.headers[0].key).toBe('X-Trace')
    const create = req(pets, 'createPet')
    expect(create.method).toBe('POST')
    expect(JSON.parse((create.body as { raw: string }).raw)).toEqual({ name: 'Rex', age: 0 })
    expect(req(value, 'Health').auth).toEqual({ type: 'none' })
  })
})

describe('code snippets and data files', () => {
  it('generates curl / fetch / python', () => {
    const r = { method: 'POST', url: 'https://x.test/a?b=1', headers: [['Content-Type', 'application/json']] as [string, string][], body: { kind: 'text' as const, text: `{"it's":1}` } }
    expect(generateSnippet(r, 'curl')).toBe(`curl -X POST 'https://x.test/a?b=1' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"it'\\''s":1}'`)
    expect(generateSnippet(r, 'js-fetch')).toContain('await fetch("https://x.test/a?b=1"')
    expect(generateSnippet(r, 'python-requests')).toContain('requests.request("POST", url, headers=headers, data=payload)')
  })
  it('parses CSV (quoted) and JSON data files', () => {
    expect(parseCsv('id,name\n1,"Smith, J"\n2,"say ""hi"""\n')).toEqual({ columns: ['id', 'name'], rows: [{ id: '1', name: 'Smith, J' }, { id: '2', name: 'say "hi"' }] })
    expect(parseDataFile('d.json', '[{"a":1,"b":"x"}]').rows).toEqual([{ a: '1', b: 'x' }])
  })
})
