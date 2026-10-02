/** Syntax highlighting for whole files, split into renderable lines. */
import hljs from 'highlight.js/lib/common'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

hljs.registerLanguage('dockerfile', dockerfile)

const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  kt: 'kotlin',
  rb: 'ruby',
  h: 'c',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  htm: 'xml',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  yml: 'yaml',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'bash',
  md: 'markdown',
  mdx: 'markdown',
  sh: 'bash',
  zsh: 'bash',
  jsonc: 'json',
  lock: 'yaml'
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.env': 'bash',
  '.zshrc': 'bash',
  '.bashrc': 'bash'
}

/** Highlighting a huge file would stall the panel; show those plain. */
const MAX_HIGHLIGHT = 400_000

export function languageOf(path: string): string | null {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (BY_NAME[name]) return BY_NAME[name]
  if (name.startsWith('.env')) return 'bash'
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  const lang = BY_EXT[ext] ?? ext
  return lang && hljs.getLanguage(lang) ? lang : null
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Split highlighted HTML into lines, closing the spans still open at each
 * line break and reopening them on the next, so each line renders alone.
 */
function splitLines(html: string): string[] {
  const out: string[] = []
  let open: string[] = []
  for (const raw of html.split('\n')) {
    const line = open.join('') + raw
    for (const tag of raw.match(/<span[^>]*>|<\/span>/g) ?? []) {
      if (tag === '</span>') open.pop()
      else open = [...open, tag]
    }
    out.push(line + '</span>'.repeat(open.length))
  }
  return out
}

export function highlightLines(code: string, path: string): string[] {
  const lang = languageOf(path)
  if (!lang || code.length > MAX_HIGHLIGHT) return code.split('\n').map(escapeHtml)
  try {
    return splitLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value)
  } catch {
    return code.split('\n').map(escapeHtml)
  }
}
