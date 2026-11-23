/** cURL command → RequestDef (pure). Handles bash quoting, line continuations and the common flags. */
import type { FormDataField, KeyValue, RawLanguage, RequestDef } from './types'
import { newRequest } from './types'
import { splitQuery } from './variables'

/** POSIX-ish shell tokenizer: '…', "…", backslash escapes, `\` + newline continuations, `$'…'`. */
export function tokenizeShell(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ')
  const out: string[] = []
  let cur = ''
  let has = false
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
      i++
      continue
    }
    has = true
    if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      cur += end < 0 ? src.slice(i + 1) : src.slice(i + 1, end)
      i = end < 0 ? src.length : end + 1
    } else if (ch === '$' && src[i + 1] === "'") {
      i += 2
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1]
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
          i += 2
        } else cur += src[i++]
      }
      i++
    } else if (ch === '"') {
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) {
          cur += src[i + 1]
          i += 2
        } else cur += src[i++]
      }
      i++
    } else if (ch === '\\' && i + 1 < src.length) {
      cur += src[i + 1]
      i += 2
    } else {
      cur += ch
      i++
    }
  }
  if (has) out.push(cur)
  return out
}

const WITH_ARG = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
  '-F', '--form', '--form-string', '-u', '--user', '--url', '-A', '--user-agent', '-b', '--cookie', '-e', '--referer',
  '--json', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '-w', '--write-out', '--cacert',
  '--cert', '--key', '-T', '--upload-file', '--max-redirs', '-c', '--cookie-jar', '--retry', '-r', '--range', '--oauth2-bearer'
])

export function isCurlCommand(text: string): boolean {
  return /^\s*curl(\.exe)?\s/i.test(text)
}

export function parseCurl(command: string): { request: RequestDef; warnings: string[] } {
  const tokens = tokenizeShell(command.trim())
  if (!tokens.length || !/^curl(\.exe)?$/i.test(tokens[0])) throw new Error('Not a cURL command (must start with "curl").')
  const warnings: string[] = []
  let method: string | undefined
  let url = ''
  const headers: KeyValue[] = []
  const data: string[] = []
  const urlencoded: KeyValue[] = []
  const form: FormDataField[] = []
  let user: string | undefined
  let bearer: string | undefined
  let forceGet = false
  let head = false
  let isJsonFlag = false
  let binaryFile: string | undefined
  const settings: RequestDef['settings'] = {}

  const args: [string, string | undefined][] = []
  for (let i = 1; i < tokens.length; i++) {
    let t = tokens[i]
    if (t.startsWith('--') && t.includes('=') && WITH_ARG.has(t.slice(0, t.indexOf('=')))) {
      args.push([t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)])
      continue
    }
    if (WITH_ARG.has(t)) {
      args.push([t, tokens[++i]])
      continue
    }
    // -XPOST, -HAccept:x
    if (/^-[A-Za-z]/.test(t) && !t.startsWith('--') && t.length > 2 && WITH_ARG.has(t.slice(0, 2))) {
      args.push([t.slice(0, 2), t.slice(2)])
      continue
    }
    // combined short flags: -sSLk
    if (/^-[A-Za-z]{2,}$/.test(t)) {
      for (const c of t.slice(1)) args.push(['-' + c, undefined])
      continue
    }
    if (!t.startsWith('-')) {
      if (!url) url = t
      continue
    }
    args.push([t, undefined])
    t = ''
  }

  for (const [flag, val = ''] of args) {
    switch (flag) {
      case '-X':
      case '--request':
        method = val.toUpperCase()
        break
      case '--url':
        url = val
        break
      case '-H':
      case '--header': {
        const idx = val.indexOf(':')
        if (idx > 0) {
          const key = val.slice(0, idx).trim()
          const value = val.slice(idx + 1).trim()
          if (key.toLowerCase() === 'authorization' && /^bearer\s+/i.test(value)) bearer = value.replace(/^bearer\s+/i, '')
          else headers.push({ key, value, enabled: true })
        }
        break
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-binary':
        if (val.startsWith('@') && flag !== '--data-raw') {
          binaryFile = val.slice(1)
        } else data.push(val)
        break
      case '--json':
        isJsonFlag = true
        data.push(val)
        break
      case '--data-urlencode': {
        const eq = val.indexOf('=')
        if (eq > 0) urlencoded.push({ key: val.slice(0, eq), value: val.slice(eq + 1), enabled: true })
        else urlencoded.push({ key: val.replace(/^=/, ''), value: '', enabled: true })
        break
      }
      case '-F':
      case '--form':
      case '--form-string': {
        const eq = val.indexOf('=')
        const key = eq >= 0 ? val.slice(0, eq) : val
        let value = eq >= 0 ? val.slice(eq + 1) : ''
        if (flag !== '--form-string' && value.startsWith('@')) {
          let path = value.slice(1)
          let contentType: string | undefined
          const semi = path.indexOf(';type=')
          if (semi >= 0) {
            contentType = path.slice(semi + 6)
            path = path.slice(0, semi)
          }
          form.push({ key, value: '', enabled: true, kind: 'file', filePath: path, ...(contentType ? { contentType } : {}) })
        } else {
          if (flag !== '--form-string' && value.startsWith('<')) value = value.slice(1)
          form.push({ key, value, enabled: true, kind: 'text' })
        }
        break
      }
      case '-u':
      case '--user':
        user = val
        break
      case '--oauth2-bearer':
        bearer = val
        break
      case '-A':
      case '--user-agent':
        headers.push({ key: 'User-Agent', value: val, enabled: true })
        break
      case '-b':
      case '--cookie':
        if (val.includes('=')) headers.push({ key: 'Cookie', value: val, enabled: true })
        else warnings.push('Cookie files (-b <file>) are not imported.')
        break
      case '-e':
      case '--referer':
        headers.push({ key: 'Referer', value: val, enabled: true })
        break
      case '-G':
      case '--get':
        forceGet = true
        break
      case '-I':
      case '--head':
        head = true
        break
      case '-k':
      case '--insecure':
        settings.verifyTls = false
        break
      case '-L':
      case '--location':
        settings.followRedirects = true
        break
      case '--max-redirs':
        settings.maxRedirects = Number(val) || undefined
        break
      case '-m':
      case '--max-time':
        if (Number(val) > 0) settings.timeoutMs = Math.round(Number(val) * 1000)
        break
      case '-T':
      case '--upload-file':
        binaryFile = val
        method = method ?? 'PUT'
        break
      default:
        break
    }
  }

  if (!url) throw new Error('cURL command has no URL.')
  url = url.replace(/^['"]|['"]$/g, '')
  const split = splitQuery(url)
  const params = split.params
  const req = newRequest({ name: url.replace(/^https?:\/\//, '').split('?')[0].slice(0, 80) || 'Imported request', url: split.base, params, headers, settings })

  const ctHeader = headers.find((h) => h.key.toLowerCase() === 'content-type')
  const ct = ctHeader?.value.toLowerCase() ?? ''
  const hasBody = data.length > 0 || urlencoded.length > 0 || form.length > 0 || binaryFile !== undefined

  if (forceGet && data.length) {
    for (const d of data) params.push(...splitQuery('?' + d).params)
  } else if (form.length) {
    req.body = { mode: 'formdata', formdata: form }
  } else if (urlencoded.length || (data.length && (ct.includes('x-www-form-urlencoded') || (!ct && !isJsonFlag && data.every((d) => /^[^=&\s{[<]+=[^&]*(&[^=&]+=[^&]*)*$/.test(d)))))) {
    const fields = [...urlencoded]
    for (const d of data) fields.push(...splitQuery('?' + d).params)
    req.body = { mode: 'urlencoded', urlencoded: fields }
    if (ctHeader && ct.includes('x-www-form-urlencoded')) headers.splice(headers.indexOf(ctHeader), 1)
  } else if (data.length) {
    const raw = data.join('&')
    const t = raw.trim()
    let language: RawLanguage = 'text'
    if (isJsonFlag || ct.includes('json') || ((t.startsWith('{') || t.startsWith('[')) && !ct)) language = 'json'
    else if (ct.includes('xml') || (!ct && t.startsWith('<'))) language = 'xml'
    else if (ct.includes('html')) language = 'html'
    else if (ct.includes('javascript')) language = 'javascript'
    req.body = { mode: 'raw', raw, language }
    if (isJsonFlag) {
      if (!ctHeader) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true })
      if (!headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push({ key: 'Accept', value: 'application/json', enabled: true })
    }
  } else if (binaryFile !== undefined) {
    req.body = { mode: 'binary', filePath: binaryFile }
  }

  req.method = method ?? (head ? 'HEAD' : hasBody && !forceGet ? 'POST' : 'GET')
  if (user !== undefined) {
    const idx = user.indexOf(':')
    req.auth = { type: 'basic', username: idx >= 0 ? user.slice(0, idx) : user, password: idx >= 0 ? user.slice(idx + 1) : '' }
  } else if (bearer !== undefined) {
    req.auth = { type: 'bearer', token: bearer }
  }
  return { request: req, warnings }
}
