/** CodeMirror wrapper themed with the app's CSS variables (works in light and dark). */
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { type Extension, RangeSetBuilder } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { forwardRef, useMemo } from 'react'

export type CodeLanguage = 'json' | 'javascript' | 'xml' | 'html' | 'text'

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg-editor)', color: 'var(--fg)', fontSize: 'var(--font-size-code)', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-gutters': { backgroundColor: 'var(--bg-editor)', color: 'var(--fg-faint)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--fg-muted)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-hover)', border: 'none', color: 'var(--fg-muted)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--fg)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
  '.cm-panels': { backgroundColor: 'var(--bg-elevated)', color: 'var(--fg)' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--search-current)' },
  '.cm-body-match': { backgroundColor: 'var(--search-match)', borderRadius: '2px' },
  '.cm-matchingBracket': { backgroundColor: 'var(--bg-hover)', outline: '1px solid var(--border)' },
  '.cm-placeholder': { color: 'var(--fg-faint)' }
})

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.tagName, t.typeName, t.className], color: 'var(--syn-tag)' },
  { tag: [t.punctuation, t.bracket, t.separator], color: 'var(--fg-muted)' },
  { tag: t.invalid, color: 'var(--danger)' }
])

function langExt(lang: CodeLanguage): Extension[] {
  switch (lang) {
    case 'json':
      return [json()]
    case 'javascript':
      return [javascript()]
    case 'xml':
      return [xml()]
    case 'html':
      return [xml()]
    default:
      return []
  }
}

/** Highlights every case-insensitive occurrence of `query` (body search). */
function matchHighlighter(query: string): Extension {
  if (!query) return []
  const mark = Decoration.mark({ class: 'cm-body-match' })
  const q = query.toLowerCase()
  const build = (view: EditorView): DecorationSet => {
    const b = new RangeSetBuilder<Decoration>()
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to).toLowerCase()
      let i = text.indexOf(q)
      while (i >= 0) {
        b.add(from + i, from + i + q.length, mark)
        i = text.indexOf(q, i + q.length)
      }
    }
    return b.finish()
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view)
      }
    },
    { decorations: (v) => v.decorations }
  )
}

export interface CodeEditorProps {
  value: string
  onChange?: (v: string) => void
  language?: CodeLanguage
  readOnly?: boolean
  placeholder?: string
  minHeight?: string
  height?: string
  search?: string
  lineNumbers?: boolean
  ariaLabel: string
  testId?: string
  wrap?: boolean
}

export const CodeEditor = forwardRef<ReactCodeMirrorRef, CodeEditorProps>(function CodeEditor(
  { value, onChange, language = 'text', readOnly, placeholder, minHeight, height = '100%', search = '', lineNumbers = true, ariaLabel, testId, wrap },
  ref
) {
  const extensions = useMemo(
    () => [
      ...langExt(language),
      theme,
      syntaxHighlighting(highlight),
      matchHighlighter(search),
      ...(wrap ? [EditorView.lineWrapping] : []),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel })
    ],
    [language, search, ariaLabel, wrap]
  )
  return (
    <div className="code-editor" data-testid={testId}>
      <CodeMirror
        ref={ref}
        value={value}
        onChange={onChange}
        theme="none"
        height={height}
        minHeight={minHeight}
        readOnly={readOnly}
        editable={!readOnly}
        placeholder={placeholder}
        extensions={extensions}
        basicSetup={{ lineNumbers, foldGutter: lineNumbers, highlightActiveLine: !readOnly, highlightActiveLineGutter: !readOnly, autocompletion: !readOnly, closeBrackets: !readOnly, searchKeymap: true }}
      />
    </div>
  )
})
