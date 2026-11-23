/** Runner data files (pure): CSV with a header row (RFC 4180 quoting) or a JSON array of objects. */

export interface ParsedDataFile {
  columns: string[]
  rows: Record<string, string>[]
}

export function parseCsv(text: string): ParsedDataFile {
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      records.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    records.push(row)
  }
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ''))
  if (!nonEmpty.length) return { columns: [], rows: [] }
  const columns = nonEmpty[0].map((c) => c.trim())
  const rows = nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {}
    columns.forEach((c, idx) => {
      if (c) o[c] = r[idx] ?? ''
    })
    return o
  })
  return { columns, rows }
}

export function parseJsonData(text: string): ParsedDataFile {
  const data: unknown = JSON.parse(text)
  if (!Array.isArray(data)) throw new Error('JSON data file must be an array of objects.')
  const columns = new Set<string>()
  const rows = data.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`Row ${i + 1} is not an object.`)
    const o: Record<string, string> = {}
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      columns.add(k)
      o[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return o
  })
  return { columns: [...columns], rows }
}

export function parseDataFile(name: string, text: string): ParsedDataFile {
  const trimmed = text.trimStart()
  if (name.toLowerCase().endsWith('.json') || trimmed.startsWith('[')) return parseJsonData(text)
  return parseCsv(text)
}
