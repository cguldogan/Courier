/**
 * Small command/option layer over `node:util.parseArgs`. Each subcommand declares its options once;
 * the same declaration drives parsing, validation errors and the generated help text, so adding a
 * subcommand is adding one `CommandSpec`.
 */
import { parseArgs } from 'node:util'

export interface OptionSpec {
  type: 'string' | 'boolean'
  /** May be given more than once (values are collected in order). */
  multiple?: boolean
  short?: string
  /** Placeholder shown in help, e.g. `<file>`. */
  arg?: string
  description: string
}

export interface CommandSpec {
  name: string
  /** One line for the command list. */
  brief: string
  summary: string
  usage: string
  positionals: { name: string; description: string }[]
  /** Options in help order. */
  options: Record<string, OptionSpec>
  /** Extra help paragraphs (exit codes, examples). */
  notes?: string[]
}

/** Bad command line: printed with a pointer to `--help`, exit code 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly command?: string
  ) {
    super(message)
    this.name = 'UsageError'
  }
}

export interface ParsedCommand {
  values: Record<string, string | boolean | string[] | undefined>
  positionals: string[]
}

export function parseCommand(spec: CommandSpec, argv: string[]): ParsedCommand {
  const options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean; short?: string }> = {}
  for (const [name, o] of Object.entries(spec.options)) options[name] = { type: o.type, ...(o.multiple ? { multiple: true } : {}), ...(o.short ? { short: o.short } : {}) }
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true })
    return { values: values as ParsedCommand['values'], positionals }
  } catch (err) {
    const code = (err as { code?: string }).code
    const msg = err instanceof Error ? err.message : String(err)
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw new UsageError(msg.replace(/\. To specify a positional argument.*$/s, '.'), spec.name)
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw new UsageError(msg, spec.name)
    throw new UsageError(msg, spec.name)
  }
}

/** `--x a=b` → `['a', 'b']`. The value may contain `=`. */
export function keyValue(raw: string, option: string): [string, string] {
  const i = raw.indexOf('=')
  if (i <= 0) throw new UsageError(`--${option} expects key=value, got "${raw}".`)
  return [raw.slice(0, i), raw.slice(i + 1)]
}

/** A non-negative integer option (with an optional minimum). */
export function intOption(raw: string | undefined, option: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw.trim())) throw new UsageError(`--${option} expects a whole number, got "${raw}".`)
  const n = Number(raw.trim())
  if (n < min || n > max) throw new UsageError(`--${option} must be between ${min} and ${max}.`)
  return n
}

function wrap(text: string, width: number, indent: number): string {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + 1 + w.length > width - indent) {
      lines.push(line)
      line = w
    } else line = line ? `${line} ${w}` : w
  }
  if (line) lines.push(line)
  return lines.join('\n' + ' '.repeat(indent))
}

export function commandHelp(spec: CommandSpec, bin = 'courier'): string {
  const out: string[] = [`Usage: ${bin} ${spec.usage}`, '', wrap(spec.summary, 100, 0), '']
  if (spec.positionals.length) {
    out.push('Arguments:')
    for (const p of spec.positionals) out.push(`  ${p.name.padEnd(36)}${wrap(p.description, 100, 38)}`)
    out.push('')
  }
  out.push('Options:')
  for (const [name, o] of Object.entries(spec.options)) {
    const flag = `${o.short ? `-${o.short}, ` : '    '}--${name}${o.arg ? ` ${o.arg}` : ''}`
    const desc = o.description + (o.multiple ? ' (repeatable)' : '')
    out.push(`  ${flag.padEnd(36)}${wrap(desc, 100, 38)}`)
  }
  for (const n of spec.notes ?? []) out.push('', n)
  return out.join('\n') + '\n'
}
