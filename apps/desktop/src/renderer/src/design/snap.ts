import type { Rect } from './model'

/** A line drawn while something snaps: `pos` on `axis`, spanning `from`..`to`. */
export interface Guide {
  axis: 'x' | 'y'
  pos: number
  from: number
  to: number
}

type Edge = 'min' | 'mid' | 'max'

const lines = (r: Rect, axis: 'x' | 'y'): Record<Edge, number> =>
  axis === 'x'
    ? { min: r.x, mid: r.x + r.width / 2, max: r.x + r.width }
    : { min: r.y, mid: r.y + r.height / 2, max: r.y + r.height }

/**
 * Snap a moving rectangle to the edges and centres of others. `edges` limits
 * which of the moving rectangle's lines may snap (a resize only moves some).
 * Returns the correction to add, and the guides to draw.
 */
export function snap(
  moving: Rect,
  targets: Rect[],
  threshold: number,
  edges: { x: Edge[]; y: Edge[] } = { x: ['min', 'mid', 'max'], y: ['min', 'mid', 'max'] }
): { dx: number; dy: number; guides: Guide[] } {
  const result = { dx: 0, dy: 0, guides: [] as Guide[] }
  for (const axis of ['x', 'y'] as const) {
    const mine = lines(moving, axis)
    let best: number | null = null
    for (const target of targets) {
      const theirs = lines(target, axis)
      for (const edge of edges[axis]) {
        for (const other of ['min', 'mid', 'max'] as const) {
          const diff = theirs[other] - mine[edge]
          if (Math.abs(diff) <= threshold && (best === null || Math.abs(diff) < Math.abs(best)))
            best = diff
        }
      }
    }
    if (best === null) continue
    if (axis === 'x') result.dx = best
    else result.dy = best
    const moved = { ...moving, x: moving.x + (axis === 'x' ? best : 0), y: moving.y + (axis === 'y' ? best : 0) }
    const snapped = lines(moved, axis)
    const cross = axis === 'x' ? 'y' : 'x'
    for (const edge of edges[axis]) {
      const hits = targets.filter((t) =>
        Object.values(lines(t, axis)).some((v) => Math.abs(v - snapped[edge]) < 0.5)
      )
      if (hits.length === 0) continue
      const spans = [moved, ...hits].map((r) => lines(r, cross))
      result.guides.push({
        axis,
        pos: snapped[edge],
        from: Math.min(...spans.map((s) => s.min)),
        to: Math.max(...spans.map((s) => s.max))
      })
    }
  }
  return result
}

export function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y
  }
}

export const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height
