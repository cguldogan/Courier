/** Request body editor: none / raw (+language, beautify) / urlencoded / form-data / GraphQL / binary. */
import type { BodyMode, RawLanguage, RequestBody } from '../../../shared/types'
import { attempt, courier } from '../api'
import { useApp } from '../store'
import { CodeEditor } from './CodeEditor'
import { KeyValueGrid } from './KeyValueGrid'

const MODES: { id: BodyMode; label: string }[] = [
  { id: 'none', label: 'none' },
  { id: 'raw', label: 'raw' },
  { id: 'urlencoded', label: 'x-www-form-urlencoded' },
  { id: 'formdata', label: 'form-data' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'binary', label: 'binary' }
]

const LANGS: { id: RawLanguage; label: string }[] = [
  { id: 'json', label: 'JSON' },
  { id: 'text', label: 'Text' },
  { id: 'xml', label: 'XML' },
  { id: 'html', label: 'HTML' },
  { id: 'javascript', label: 'JavaScript' }
]

function switchMode(body: RequestBody, mode: BodyMode): RequestBody {
  if (body.mode === mode) return body
  switch (mode) {
    case 'none':
      return { mode }
    case 'raw':
      return { mode, raw: '', language: 'json' }
    case 'urlencoded':
      return { mode, urlencoded: [] }
    case 'formdata':
      return { mode, formdata: [] }
    case 'graphql':
      return { mode, graphql: { query: '', variables: '' } }
    case 'binary':
      return { mode, filePath: '' }
  }
}

/** Pretty-print JSON while keeping `{{var}}` placeholders (inside or outside strings). */
export function beautifyJson(text: string): string | null {
  const holders: { text: string; quoted: boolean }[] = []
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2)
      if (end > 0 && !text.slice(i + 2, end).includes('{')) {
        const h = { text: text.slice(i, end + 2), quoted: !inString }
        holders.push(h)
        out += h.quoted ? `"__CV${holders.length - 1}__"` : `__CV${holders.length - 1}__`
        i = end + 1
        continue
      }
    }
    if (ch === '"') {
      let bs = 0
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) bs++
      if (bs % 2 === 0) inString = !inString
    }
    out += ch
  }
  try {
    let pretty = JSON.stringify(JSON.parse(out), null, 2)
    holders.forEach((h, i) => {
      pretty = pretty.replace(h.quoted ? `"__CV${i}__"` : `__CV${i}__`, () => h.text)
    })
    return pretty
  } catch {
    return null
  }
}

export function BodyEditor({ body, onChange, collectionId }: { body: RequestBody; onChange: (b: RequestBody) => void; collectionId: string | null }): React.JSX.Element {
  const toast = useApp((s) => s.toast)
  return (
    <div className="body-editor">
      <div className="body-toolbar">
        <div className="radio-row" role="radiogroup" aria-label="Body type">
          {MODES.map((m) => (
            <label key={m.id} className="radio">
              <input type="radio" name="body-mode" value={m.id} checked={body.mode === m.id} onChange={() => onChange(switchMode(body, m.id))} />
              {m.label}
            </label>
          ))}
        </div>
        {body.mode === 'raw' && (
          <div className="body-tools">
            <select aria-label="Raw language" data-testid="raw-language" value={body.language} onChange={(e) => onChange({ ...body, language: e.target.value as RawLanguage })}>
              {LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            {body.language === 'json' && (
              <button
                className="btn small"
                onClick={() => {
                  const out = beautifyJson(body.raw)
                  if (out === null) toast('error', 'The body is not valid JSON.')
                  else onChange({ ...body, raw: out })
                }}
              >
                Beautify
              </button>
            )}
          </div>
        )}
      </div>
      <div className="body-content">
        {body.mode === 'none' && <p className="muted empty-note">This request does not have a body.</p>}
        {body.mode === 'raw' && (
          <CodeEditor value={body.raw} onChange={(raw) => onChange({ ...body, raw })} language={body.language === 'html' ? 'html' : body.language} ariaLabel="Request body" testId="body-editor" />
        )}
        {body.mode === 'urlencoded' && <KeyValueGrid testId="urlencoded-grid" rows={body.urlencoded} collectionId={collectionId} onChange={(urlencoded) => onChange({ ...body, urlencoded })} />}
        {body.mode === 'formdata' && <KeyValueGrid testId="formdata-grid" formData rows={body.formdata} collectionId={collectionId} allowBulk={false} onChange={(formdata) => onChange({ ...body, formdata: formdata.map((f) => ({ ...f, kind: f.kind ?? 'text' })) })} />}
        {body.mode === 'graphql' && (
          <div className="graphql">
            <div className="graphql-pane">
              <div className="pane-label">Query</div>
              <CodeEditor value={body.graphql.query} onChange={(query) => onChange({ ...body, graphql: { ...body.graphql, query } })} language="javascript" ariaLabel="GraphQL query" placeholder="query { … }" />
            </div>
            <div className="graphql-pane">
              <div className="pane-label">Variables (JSON)</div>
              <CodeEditor value={body.graphql.variables} onChange={(variables) => onChange({ ...body, graphql: { ...body.graphql, variables } })} language="json" ariaLabel="GraphQL variables" placeholder="{}" />
            </div>
          </div>
        )}
        {body.mode === 'binary' && (
          <div className="binary">
            <button
              className="btn"
              onClick={async () => {
                const f = await attempt(courier().files.pickFile({ title: 'Choose request body file' }))
                if (f) onChange({ mode: 'binary', filePath: f.path })
              }}
            >
              Choose file
            </button>
            <span className="muted ellipsis" title={body.filePath}>
              {body.filePath || 'No file selected'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
