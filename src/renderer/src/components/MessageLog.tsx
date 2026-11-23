/** WebSocket / gRPC message log: direction filter, search, pings, auto-scroll, clear, bounded with a notice. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { LOG_MAX_BYTES, LOG_MAX_ENTRIES, hexPreview, type BoundedLog } from '../../../shared/realtime'
import type { RealtimeLogEntry } from '../../../shared/types'
import { CodeEditor } from './CodeEditor'
import { Icon, copyText, formatBytes } from './ui'

type Dir = 'all' | 'out' | 'in'

function time(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function pretty(text: string): { text: string; json: boolean } {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return { text, json: false }
  try {
    return { text: JSON.stringify(JSON.parse(t), null, 2), json: true }
  } catch {
    return { text, json: false }
  }
}

function base64ToBytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
}

function Row({ e, expanded, onToggle, elapsed }: { e: RealtimeLogEntry; expanded: boolean; onToggle: () => void; elapsed?: boolean }): React.JSX.Element {
  const isPayload = e.kind === 'text' || e.kind === 'binary'
  const preview = e.kind === 'binary' ? hexPreview(e.base64 ?? '', 48) : (e.text ?? '').replace(/\s+/g, ' ')
  const label = e.direction === 'out' ? 'Sent' : e.direction === 'in' ? 'Received' : e.kind === 'error' ? 'Error' : 'Event'
  return (
    <div className={`log-row dir-${e.direction} kind-${e.kind} ${expanded ? 'open' : ''}`} data-testid="log-row" data-direction={e.direction} data-kind={e.kind}>
      <button className="log-line" data-testid="log-line" aria-expanded={isPayload ? expanded : undefined} aria-label={`${label} ${e.kind} message at ${time(e.at)}`} onClick={isPayload ? onToggle : undefined} disabled={!isPayload}>
        <span className={`log-dir dir-${e.direction}`} aria-hidden="true">
          {e.direction === 'out' ? '↑' : e.direction === 'in' ? '↓' : e.kind === 'error' ? '!' : '•'}
        </span>
        <span className="log-time mono">{elapsed && e.elapsedMs !== undefined ? `+${e.elapsedMs} ms` : time(e.at)}</span>
        {e.kind === 'binary' && <span className="log-tag">BIN</span>}
        {(e.kind === 'ping' || e.kind === 'pong') && <span className="log-tag">{e.kind.toUpperCase()}</span>}
        <span className="log-preview mono" data-testid="log-preview">
          {preview || (e.kind === 'ping' || e.kind === 'pong' ? '' : '(empty)')}
        </span>
        {isPayload && <span className="log-size muted small">{formatBytes(e.size)}</span>}
      </button>
      {expanded && isPayload && (
        <div className="log-detail" data-testid="log-detail">
          {e.kind === 'binary' ? (
            <pre className="pre-box mono">{hexPreview(e.base64 ?? '', 4096)}</pre>
          ) : (
            (() => {
              const p = pretty(e.text ?? '')
              return (
                <div className="log-code">
                  <CodeEditor value={p.text} readOnly language={p.json ? 'json' : 'text'} ariaLabel="Message content" height="auto" minHeight="40px" wrap />
                </div>
              )
            })()
          )}
          <div className="log-detail-bar">
            {e.truncated && <span className="warn-text small">Shown truncated ({formatBytes(e.kind === 'binary' ? base64ToBytes(e.base64 ?? '') : (e.text ?? '').length)} of {formatBytes(e.size)}).</span>}
            <button className="link-btn small" aria-label="Copy message" data-testid="log-copy" onClick={() => void copyText(e.kind === 'binary' ? (e.base64 ?? '') : (e.text ?? ''), 'Message copied')}>
              Copy{e.kind === 'binary' ? ' as base64' : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function MessageLog({ log, onClear, pings, testId, elapsed, empty }: { log: BoundedLog; onClear: () => void; pings?: boolean; testId: string; elapsed?: boolean; empty: string }): React.JSX.Element {
  const [dir, setDir] = useState<Dir>('all')
  const [q, setQ] = useState('')
  const [showPings, setShowPings] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const listRef = useRef<HTMLDivElement>(null)
  const query = q.trim().toLowerCase()
  const shown = useMemo(
    () =>
      log.entries.filter((e) => {
        if (dir !== 'all' && e.direction !== dir) return false
        if (!showPings && (e.kind === 'ping' || e.kind === 'pong')) return false
        if (query && !(e.text ?? '').toLowerCase().includes(query) && !(e.kind === 'binary' && hexPreview(e.base64 ?? '', 4096).includes(query))) return false
        return true
      }),
    [log.entries, dir, showPings, query]
  )
  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [shown.length, autoScroll])
  return (
    <div className="message-log" data-testid={testId}>
      <div className="body-view-bar log-bar">
        <div className="seg" role="radiogroup" aria-label="Filter by direction">
          {(['all', 'out', 'in'] as Dir[]).map((d) => (
            <button key={d} role="radio" aria-label={d === 'all' ? 'All messages' : d === 'out' ? 'Sent messages' : 'Received messages'} aria-checked={dir === d} data-testid={`log-filter-${d}`} className={`seg-btn ${dir === d ? 'on' : ''}`} onClick={() => setDir(d)}>
              {d === 'all' ? 'All' : d === 'out' ? 'Sent' : 'Received'}
            </button>
          ))}
        </div>
        <div className="search-box">
          <Icon name="search" size={12} />
          <input aria-label="Search messages" data-testid="log-search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grow" />
        {pings && (
          <label className="check small" title="Show ping and pong frames">
            <input type="checkbox" aria-label="Show pings" data-testid="log-show-pings" checked={showPings} onChange={(e) => setShowPings(e.target.checked)} /> Pings
          </label>
        )}
        <label className="check small" title="Keep the newest message in view">
          <input type="checkbox" aria-label="Auto-scroll" data-testid="log-autoscroll" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> Auto-scroll
        </label>
        <button className="btn small" aria-label="Clear messages" data-testid="log-clear" disabled={!log.entries.length && !log.dropped} onClick={onClear}>
          Clear
        </button>
      </div>
      {log.dropped > 0 && (
        <div className="warn-box small log-dropped" data-testid="log-dropped">
          <Icon name="warn" size={12} /> {log.dropped} older message{log.dropped === 1 ? ' was' : 's were'} dropped: the log keeps the newest {LOG_MAX_ENTRIES} messages ({formatBytes(LOG_MAX_BYTES)}) in memory only.
        </div>
      )}
      <div className="log-list" ref={listRef} role="log" aria-label="Messages" data-testid="log-list">
        {shown.length === 0 && <p className="muted pad">{log.entries.length ? 'No messages match the filter.' : empty}</p>}
        {shown.map((e) => (
          <Row key={e.seq} e={e} elapsed={elapsed} expanded={!!open[e.seq]} onToggle={() => setOpen((o) => ({ ...o, [e.seq]: !o[e.seq] }))} />
        ))}
      </div>
    </div>
  )
}

export function PairsTable({ rows, testId, empty }: { rows: [string, string][]; testId: string; empty: string }): React.JSX.Element {
  if (!rows.length) return <p className="muted small">{empty}</p>
  return (
    <table className="data-table" data-testid={testId}>
      <thead>
        <tr>
          <th style={{ width: '32%' }}>Key</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i}>
            <td className="mono">{k}</td>
            <td className="mono break">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
