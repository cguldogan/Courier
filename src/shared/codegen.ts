/** Code snippet generation (pure) from an already-resolved request description. */
import type { SnippetLanguage } from './types'

export type SnippetBody =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'urlencoded'; fields: [string, string][] }
  | { kind: 'formdata'; fields: { key: string; value?: string; filePath?: string }[] }
  | { kind: 'file'; filePath: string }

export interface SnippetRequest {
  method: string
  url: string
  headers: [string, string][]
  body: SnippetBody
}

const shq = (v: string): string => "'" + v.replace(/'/g, `'\\''`) + "'"
const jsq = (v: string): string => JSON.stringify(v)
const pyq = (v: string): string => JSON.stringify(v)

function curl(r: SnippetRequest): string {
  const lines = [`curl -X ${r.method} ${shq(r.url)}`]
  for (const [k, v] of r.headers) lines.push(`-H ${shq(`${k}: ${v}`)}`)
  const b = r.body
  if (b.kind === 'text') lines.push(`--data-raw ${shq(b.text)}`)
  else if (b.kind === 'urlencoded') for (const [k, v] of b.fields) lines.push(`--data-urlencode ${shq(`${k}=${v}`)}`)
  else if (b.kind === 'formdata')
    for (const f of b.fields) lines.push(`-F ${shq(f.filePath !== undefined ? `${f.key}=@${f.filePath}` : `${f.key}=${f.value ?? ''}`)}`)
  else if (b.kind === 'file') lines.push(`--data-binary ${shq('@' + b.filePath)}`)
  return lines.join(' \\\n  ')
}

function jsFetch(r: SnippetRequest): string {
  const out: string[] = []
  const b = r.body
  let bodyExpr: string | undefined
  if (b.kind === 'text') bodyExpr = jsq(b.text)
  else if (b.kind === 'urlencoded') {
    out.push('const body = new URLSearchParams();')
    for (const [k, v] of b.fields) out.push(`body.append(${jsq(k)}, ${jsq(v)});`)
    bodyExpr = 'body'
  } else if (b.kind === 'formdata') {
    out.push('const body = new FormData();')
    for (const f of b.fields)
      out.push(f.filePath !== undefined ? `body.append(${jsq(f.key)}, fileInput.files[0], ${jsq(f.filePath)});` : `body.append(${jsq(f.key)}, ${jsq(f.value ?? '')});`)
    bodyExpr = 'body'
  } else if (b.kind === 'file') {
    out.push(`// body: contents of ${b.filePath}`)
    bodyExpr = 'fileBlob'
  }
  const headers = r.headers.filter(([k]) => !(b.kind === 'formdata' && k.toLowerCase() === 'content-type'))
  const opts: string[] = [`  method: ${jsq(r.method)}`]
  if (headers.length) opts.push(`  headers: {\n${headers.map(([k, v]) => `    ${jsq(k)}: ${jsq(v)}`).join(',\n')}\n  }`)
  if (bodyExpr) opts.push(`  body: ${bodyExpr}`)
  out.push(`const response = await fetch(${jsq(r.url)}, {\n${opts.join(',\n')}\n});`)
  out.push('console.log(response.status, await response.text());')
  return out.join('\n')
}

function python(r: SnippetRequest): string {
  const out = ['import requests', '']
  out.push(`url = ${pyq(r.url)}`)
  const b = r.body
  const headers = r.headers.filter(([k]) => !(b.kind === 'formdata' && k.toLowerCase() === 'content-type'))
  if (headers.length) out.push(`headers = {\n${headers.map(([k, v]) => `    ${pyq(k)}: ${pyq(v)}`).join(',\n')}\n}`)
  const args = ['url']
  if (headers.length) args.push('headers=headers')
  if (b.kind === 'text') {
    out.push(`payload = ${pyq(b.text)}`)
    args.push('data=payload')
  } else if (b.kind === 'urlencoded') {
    out.push(`payload = {\n${b.fields.map(([k, v]) => `    ${pyq(k)}: ${pyq(v)}`).join(',\n')}\n}`)
    args.push('data=payload')
  } else if (b.kind === 'formdata') {
    const text = b.fields.filter((f) => f.filePath === undefined)
    const files = b.fields.filter((f) => f.filePath !== undefined)
    if (text.length) {
      out.push(`payload = {\n${text.map((f) => `    ${pyq(f.key)}: ${pyq(f.value ?? '')}`).join(',\n')}\n}`)
      args.push('data=payload')
    }
    if (files.length) {
      out.push(`files = {\n${files.map((f) => `    ${pyq(f.key)}: open(${pyq(f.filePath as string)}, "rb")`).join(',\n')}\n}`)
      args.push('files=files')
    }
  } else if (b.kind === 'file') {
    out.push(`payload = open(${pyq(b.filePath)}, "rb")`)
    args.push('data=payload')
  }
  out.push('')
  out.push(`response = requests.request(${pyq(r.method)}, ${args.join(', ')})`)
  out.push('print(response.status_code, response.text)')
  return out.join('\n')
}

export const SNIPPET_LANGUAGES: { id: SnippetLanguage; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'js-fetch', label: 'JavaScript (fetch)' },
  { id: 'python-requests', label: 'Python (requests)' }
]

export function generateSnippet(r: SnippetRequest, language: SnippetLanguage): string {
  switch (language) {
    case 'curl':
      return curl(r)
    case 'js-fetch':
      return jsFetch(r)
    case 'python-requests':
      return python(r)
  }
}
