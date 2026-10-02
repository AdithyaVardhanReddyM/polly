import { structuredPatch } from 'diff'
import { useMemo } from 'react'

interface Props {
  before: string
  after: string
  /** Lines of context around each change. */
  context?: number
  /** Cap rendered lines so a huge rewrite cannot freeze the panel. */
  maxLines?: number
}

interface Line {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
  oldNo?: number
  newNo?: number
}

/** A unified diff with old/new line numbers. */
export function DiffView({ before, after, context = 3, maxLines = 800 }: Props): React.JSX.Element {
  const { lines, hidden } = useMemo(() => {
    const patch = structuredPatch('a', 'b', before, after, '', '', { context })
    const out: Line[] = []
    for (const hunk of patch.hunks) {
      out.push({
        kind: 'hunk',
        text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
      })
      let oldNo = hunk.oldStart
      let newNo = hunk.newStart
      for (const raw of hunk.lines) {
        if (raw.startsWith('\\')) continue // "\ No newline at end of file"
        const text = raw.slice(1)
        if (raw[0] === '+') out.push({ kind: 'add', text, newNo: newNo++ })
        else if (raw[0] === '-') out.push({ kind: 'del', text, oldNo: oldNo++ })
        else out.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ })
      }
    }
    return { lines: out.slice(0, maxLines), hidden: Math.max(0, out.length - maxLines) }
  }, [before, after, context, maxLines])

  if (lines.length === 0) return <div className="diff-empty">No textual changes.</div>

  return (
    <div className="diff" role="table">
      {lines.map((l, i) =>
        l.kind === 'hunk' ? (
          <div key={i} className="diff-hunk">
            {l.text}
          </div>
        ) : (
          <div key={i} className={`diff-line is-${l.kind}`}>
            <span className="diff-no">{l.oldNo ?? ''}</span>
            <span className="diff-no">{l.newNo ?? ''}</span>
            <span className="diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className="diff-text">{l.text || ' '}</span>
          </div>
        )
      )}
      {hidden > 0 && <div className="diff-hunk">… {hidden} more lines</div>}
    </div>
  )
}
