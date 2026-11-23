/** Filename-safe slugs (pure). Lowercase `[a-z0-9-]`, never empty, safe on case-insensitive filesystems. */

const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'])

export function slugify(name: string, maxLength = 60): string {
  let s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length > maxLength) s = s.slice(0, maxLength).replace(/-+$/g, '')
  if (!s) s = 'untitled'
  if (RESERVED.has(s)) s += '-x'
  return s
}

/** First free of `base`, `base-2`, `base-3`… (comparison is case-insensitive). */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((t) => t.toLowerCase()))
  if (!set.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!set.has(candidate)) return candidate
  }
}
