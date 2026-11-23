/** Small shared UI primitives: icons, modal, context menu, popover, variable-highlighting input. */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useApp } from '../store'
import { describeToken, layersFor, tokenize } from '../vars'

// ---------------------------------------------------------------------------------------------
// Icons (inline SVG, stroke = currentColor)
// ---------------------------------------------------------------------------------------------

const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  sync: 'M21 12a9 9 0 0 1-15.4 6.4M3 12A9 9 0 0 1 18.4 5.6M18 2v4h-4M6 22v-4h4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  play: 'M6 4l14 8-14 8z',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7zM16 10h.01',
  cookie: 'M21 12a9 9 0 1 1-9-9 4 4 0 0 0 4 4 4 4 0 0 0 5 5zM8.5 8.5h.01M15.5 15.5h.01M10 16h.01M7 12h.01',
  import: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  export: 'M12 21V9M7 14l5-5 5 5M5 3h14',
  dots: 'M12 6h.01M12 12h.01M12 18h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  save: 'M5 3h11l5 5v13H3V3h2zM7 3v6h9V3M7 21v-7h10v7',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  cloud: 'M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z',
  laptop: 'M4 5h16v11H4zM2 19h20',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  split: 'M3 4h18v16H3zM12 4v16',
  splitH: 'M3 4h18v16H3zM3 12h18',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  warn: 'M12 3l10 18H2L12 3zM12 10v5M12 18h.01',
  check: 'M5 12l5 5L20 7',
  stop: 'M6 6h12v12H6z',
  wand: 'M15 4V2M15 10V8M11 6h2M17 6h2M3 21l12-12',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4'
}

export function Icon({ name, size = 14, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }): React.JSX.Element {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}

export function Spinner({ size = 12 }: { size?: number }): React.JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Working" />
}

export function MethodBadge({ method, short }: { method: string; short?: boolean }): React.JSX.Element {
  const m = method.toUpperCase()
  const label = short ? ({ DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' } as Record<string, string>)[m] ?? m : m
  return <span className={`method method-${m.toLowerCase()}`}>{label}</span>
}

/** Sidebar / tab badge for non-HTTP requests (where HTTP shows the method). */
export function KindBadge({ kind }: { kind: 'websocket' | 'grpc' }): React.JSX.Element {
  return (
    <span className={`method kind-badge kind-${kind}`} data-testid="kind-badge" data-kind={kind} title={kind === 'websocket' ? 'WebSocket request' : 'gRPC request'}>
      {kind === 'websocket' ? 'WS' : 'gRPC'}
    </span>
  )
}

/** Where an item lives: Personal (this machine) or a team. */
export function LocationBadge({ teamId }: { teamId?: string | null }): React.JSX.Element {
  const team = useApp((s) => (teamId ? s.snapshot?.teams.find((t) => t.id === teamId) : undefined))
  const title = teamId ? `Team “${team?.name ?? 'unknown'}”${team ? ` — ${team.accountUrl}/${team.container}` : ''}` : 'Personal — stored on this machine only'
  return (
    <span className={`space-badge ${teamId ? 'space-team' : 'space-personal'}`} title={title} data-testid="location-badge">
      <Icon name={teamId ? 'users' : 'laptop'} size={11} />
    </span>
  )
}

export function statusClass(status?: number): string {
  if (!status) return 'st-none'
  if (status < 300) return 'st-ok'
  if (status < 400) return 'st-redirect'
  if (status < 500) return 'st-client'
  return 'st-server'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function formatMs(n: number): string {
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`
}

export function timeAgo(iso?: string): string {
  if (!iso) return 'never'
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 45) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)} min ago`
  if (d < 86400) return `${Math.round(d / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

export async function copyText(text: string, what = 'Copied to clipboard'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    useApp.getState().toast('success', what)
  } catch (err) {
    useApp.getState().toast('error', `Copy failed: ${String(err)}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
  testId,
  className
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  testId?: string
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]):not([disabled]), textarea, select, button.primary')
    first?.focus()
    return () => prev?.focus?.()
  }, [])
  // Escape closes the top-most modal even when focus has left it (e.g. a button became disabled).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const all = document.querySelectorAll('.modal')
      if (all[all.length - 1] !== ref.current) return
      if (document.querySelector('.menu')) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className={`modal ${className ?? ''}`}
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        data-testid={testId}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Context menu (one at a time, global)
// ---------------------------------------------------------------------------------------------

export interface MenuItem {
  label: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  submenu?: MenuItem[]
  hint?: string
}

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null
  open: (x: number, y: number, items: MenuItem[]) => void
  close: () => void
}

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set({ menu: null })
}))

export function openMenuAt(e: React.MouseEvent, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  useMenu.getState().open(e.clientX, e.clientY, items)
}

export function openMenuBelow(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect()
  useMenu.getState().open(r.left, r.bottom + 2, items)
}

function MenuList({ items, x, y, onDone }: { items: MenuItem[]; x: number; y: number; onDone: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [sub, setSub] = useState<{ idx: number; x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
    el.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus()
  }, [x, y])
  const move = (dir: 1 | -1): void => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>(':scope > [role=menuitem]:not([aria-disabled=true])') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    all[(i + dir + all.length) % all.length]?.focus()
  }
  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        } else if (e.key === 'Escape') onDone()
      }}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <div
            key={i}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={it.disabled || undefined}
            aria-haspopup={it.submenu ? 'menu' : undefined}
            className={`menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
            onMouseEnter={(e) => {
              if (it.submenu) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setSub({ idx: i, x: r.right - 2, y: r.top - 4 })
              } else setSub(null)
            }}
            onClick={(e) => {
              if (it.disabled) return
              if (it.submenu) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setSub({ idx: i, x: r.right - 2, y: r.top - 4 })
                return
              }
              onDone()
              it.onClick?.()
            }}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !it.disabled) {
                e.preventDefault()
                ;(e.currentTarget as HTMLElement).click()
              }
            }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.submenu && <Icon name="chevron" size={12} />}
          </div>
        )
      )}
      {sub && items[sub.idx]?.submenu && <MenuList items={items[sub.idx].submenu as MenuItem[]} x={sub.x} y={sub.y} onDone={onDone} />}
    </div>
  )
}

export function ContextMenuHost(): React.JSX.Element | null {
  const menu = useMenu((s) => s.menu)
  const close = useMenu((s) => s.close)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.menu')) close()
    }
    const onBlur = (): void => close()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  }, [menu, close])
  if (!menu) return null
  return <MenuList items={menu.items} x={menu.x} y={menu.y} onDone={close} />
}

// ---------------------------------------------------------------------------------------------
// Popover anchored to an element
// ---------------------------------------------------------------------------------------------

export function Popover({ anchor, onClose, children, align = 'left', width = 360, testId }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; width?: number; testId?: string }): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      if ((t as HTMLElement).closest?.('.modal-backdrop, .menu')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  if (!anchor) return null
  const r = anchor.getBoundingClientRect()
  const w = Math.min(width, window.innerWidth - 16)
  const left = align === 'right' ? Math.max(8, r.right - w) : Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
  return (
    <div ref={ref} className="popover" style={{ left, top: r.bottom + 6, width: w }} data-testid={testId} role="dialog">
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Input with {{variable}} highlighting (resolved / unresolved / vault) and hover preview
// ---------------------------------------------------------------------------------------------

export function VarInput({
  value,
  onChange,
  collectionId,
  placeholder,
  className,
  ariaLabel,
  testId,
  onKeyDown,
  onFocus,
  onBlur,
  disabled,
  type
}: {
  value: string
  onChange: (v: string) => void
  collectionId?: string | null
  placeholder?: string
  className?: string
  ariaLabel: string
  testId?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onFocus?: () => void
  onBlur?: () => void
  disabled?: boolean
  type?: string
}): React.JSX.Element {
  const snap = useApp((s) => s.snapshot)
  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const hasVars = value.includes('{{')
  const tokens = hasVars ? tokenize(value, layersFor(snap, collectionId)) : []
  const sync = (): void => {
    if (mirrorRef.current && inputRef.current) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft
  }
  useLayoutEffect(sync)
  const title = tokens.filter((t) => t.kind !== 'text').map(describeToken).join('\n')
  const masked = type === 'password'
  return (
    <div className={`var-input ${className ?? ''} ${hasVars && !masked ? 'has-vars' : ''}`} title={title || undefined}>
      {hasVars && !masked && (
        <div className="var-mirror" ref={mirrorRef} aria-hidden="true">
          {tokens.map((t, i) => (
            <span key={i} className={t.kind === 'text' ? undefined : `tok tok-${t.kind}`}>
              {t.text}
            </span>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        type={type ?? 'text'}
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(e) => {
          onChange(e.target.value)
          requestAnimationFrame(sync)
        }}
        onScroll={sync}
        onKeyUp={sync}
        onSelect={sync}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Sub-tabs
// ---------------------------------------------------------------------------------------------

export function SubTabs<T extends string>({ tabs, value, onChange, testId, right }: { tabs: { id: T; label: ReactNode; badge?: ReactNode }[]; value: T; onChange: (v: T) => void; testId?: string; right?: ReactNode }): React.JSX.Element {
  return (
    <div className="subtabs" role="tablist" data-testid={testId}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`subtab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.badge !== undefined && t.badge !== null && t.badge !== 0 && <span className="subtab-badge">{t.badge}</span>}
        </button>
      ))}
      {right && <div className="subtabs-right">{right}</div>}
    </div>
  )
}

/** Drag handle that reports pixel deltas (for resizable panes). */
export function Splitter({ direction, onDrag, onEnd, label }: { direction: 'x' | 'y'; onDrag: (delta: number) => void; onEnd?: () => void; label: string }): React.JSX.Element {
  return (
    <div
      className={`splitter splitter-${direction}`}
      role="separator"
      aria-label={label}
      aria-orientation={direction === 'x' ? 'vertical' : 'horizontal'}
      onMouseDown={(e) => {
        e.preventDefault()
        let last = direction === 'x' ? e.clientX : e.clientY
        document.body.classList.add(direction === 'x' ? 'resizing-x' : 'resizing-y')
        const move = (ev: MouseEvent): void => {
          const cur = direction === 'x' ? ev.clientX : ev.clientY
          onDrag(cur - last)
          last = cur
        }
        const up = (): void => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          document.body.classList.remove('resizing-x', 'resizing-y')
          onEnd?.()
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    />
  )
}
