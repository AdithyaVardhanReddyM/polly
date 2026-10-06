import { formatTokens } from '../coder/toolMeta'

/** "820 B", "340 KB", "4.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** "48k tokens", "1.2M tokens". */
export const formatSize = (tokens: number): string =>
  `${formatTokens(tokens)} token${tokens === 1 ? '' : 's'}`

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`

/** Code spans and fences: citations inside them are left alone. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/
/** `[3]` or `[1, 2]`, not a link (`[1](…)`) or a reference definition (`[1]: …`). */
const CITES = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?![(:])/g

export const CITE_HREF = '#kb-cite-'

/** Turn `[n]` into links the answer view draws as chips, for the sources it has. */
export function linkCitations(text: string, ids: Set<number>): string {
  if (ids.size === 0 || !text.includes('[')) return text
  return text
    .split(CODE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(CITES, (whole, list: string) => {
            const ns = list.split(',').map((s) => Number(s.trim()))
            if (!ns.every((n) => ids.has(n))) return whole
            return ns.map((n) => `[${n}](${CITE_HREF}${n})`).join('')
          })
    )
    .join('')
}

/** The source numbers an answer actually cites. */
export function citedIn(text: string): Set<number> {
  const found = new Set<number>()
  for (const part of text.split(CODE).filter((_, i) => i % 2 === 0)) {
    for (const m of part.matchAll(CITES)) {
      for (const n of m[1].split(',')) found.add(Number(n.trim()))
    }
  }
  return found
}
