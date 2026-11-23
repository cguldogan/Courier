/** Pre-request / post-response script editors with insertable snippets. */
import { useState } from 'react'
import { CodeEditor } from './CodeEditor'
import { SubTabs } from './ui'

const PRE_SNIPPETS: { label: string; code: string }[] = [
  { label: 'Set an environment variable', code: "pm.environment.set('name', 'value');" },
  { label: 'Get an environment variable', code: "const value = pm.environment.get('name');" },
  { label: 'Set a request variable', code: "pm.variables.set('requestId', pm.variables.replaceIn('{{$guid}}'));" },
  { label: 'Add a header', code: "pm.request.headers.upsert({ key: 'X-Request-Id', value: pm.variables.replaceIn('{{$guid}}') });" },
  { label: 'Read a Key Vault secret', code: "pm.vault.get('secret-name').then((v) => pm.variables.set('secret', v));" },
  { label: 'Send another request', code: "pm.sendRequest('https://example.com/health', (err, res) => {\n  console.log(err ? err : res.code);\n});" },
  { label: 'Log to console', code: "console.log('request', pm.request.url);" }
]

const TEST_SNIPPETS: { label: string; code: string }[] = [
  { label: 'Status code is 200', code: "pm.test('Status code is 200', () => {\n  pm.response.to.have.status(200);\n});" },
  { label: 'Response time is below 500 ms', code: "pm.test('Response time is below 500 ms', () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});" },
  { label: 'JSON value check', code: "pm.test('Body has id', () => {\n  const json = pm.response.json();\n  pm.expect(json).to.have.property('id');\n});" },
  { label: 'Body contains string', code: "pm.test('Body contains string', () => {\n  pm.expect(pm.response.text()).to.include('ok');\n});" },
  { label: 'Header is present', code: "pm.test('Content-Type is present', () => {\n  pm.expect(pm.response.headers.get('Content-Type')).to.be.ok;\n});" },
  { label: 'Save a value from the response', code: "const json = pm.response.json();\npm.environment.set('token', json.token);" },
  { label: 'Log the response', code: 'console.log(pm.response.code, pm.response.text());' }
]

export function ScriptEditor({ pre, test, onChange }: { pre: string; test: string; onChange: (patch: { preRequestScript?: string; testScript?: string }) => void }): React.JSX.Element {
  const [phase, setPhase] = useState<'pre' | 'test'>(pre && !test ? 'pre' : test ? 'test' : 'pre')
  const value = phase === 'pre' ? pre : test
  const set = (v: string): void => onChange(phase === 'pre' ? { preRequestScript: v } : { testScript: v })
  const snippets = phase === 'pre' ? PRE_SNIPPETS : TEST_SNIPPETS
  return (
    <div className="scripts">
      <SubTabs
        testId="script-phase"
        value={phase}
        onChange={setPhase}
        tabs={[
          { id: 'pre', label: 'Pre-request', badge: pre.trim() ? '●' : undefined },
          { id: 'test', label: 'Post-response', badge: test.trim() ? '●' : undefined }
        ]}
      />
      <div className="scripts-body">
        <div className="scripts-editor">
          <CodeEditor
            key={phase}
            language="javascript"
            value={value}
            onChange={set}
            ariaLabel={phase === 'pre' ? 'Pre-request script' : 'Post-response script'}
            testId={phase === 'pre' ? 'pre-script' : 'test-script'}
            placeholder={phase === 'pre' ? '// Runs before the request is sent' : '// Runs after the response arrives — use pm.test(...)'}
          />
        </div>
        <aside className="snippets" aria-label="Snippets">
          <div className="snippets-title">Snippets</div>
          {snippets.map((s) => (
            <button key={s.label} className="snippet-btn" onClick={() => set(value ? `${value.replace(/\s*$/, '')}\n\n${s.code}\n` : `${s.code}\n`)}>
              {s.label}
            </button>
          ))}
          <p className="muted small">Scripts run in an isolated sandbox with a time and memory limit.</p>
        </aside>
      </div>
    </div>
  )
}
