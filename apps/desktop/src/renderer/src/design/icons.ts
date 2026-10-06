/**
 * Real Lucide icons on the canvas. The Designer writes a placeholder by name,
 * `<i data-lucide="credit-card" class="h-5 w-5 text-slate-500"></i>`, instead
 * of drawing paths itself; here each one becomes Lucide's own SVG, keeping the
 * placeholder's id, classes and style. Lucide is loaded the first time a
 * design uses an icon.
 */

type Renderer = (name: string, strokeWidth: number) => string

let renderer: Promise<Renderer> | null = null

function load(): Promise<Renderer> {
  renderer ??= Promise.all([import('lucide-react'), import('react-dom/server'), import('react')]).then(
    ([lucide, server, react]) => {
      const library = lucide as unknown as Record<string, React.ComponentType<{ strokeWidth?: number }>>
      return (name, strokeWidth) => {
        // Lucide's names are kebab-case; its components (aliases included) are PascalCase.
        const pascal = name
          .trim()
          .split(/[-_\s]+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join('')
        const Icon = library[pascal] ?? library.CircleDashed
        return server.renderToStaticMarkup(react.createElement(Icon, { strokeWidth }))
      }
    }
  )
  return renderer
}

/** Swap every icon placeholder under `scope` for its SVG; true when any changed. */
export async function expandIcons(scope: Element): Promise<boolean> {
  const holders = Array.from(scope.querySelectorAll('[data-lucide]:not(svg)'))
  if (holders.length === 0) return false
  const render = await load()
  const doc = scope.ownerDocument
  for (const holder of holders) {
    if (!holder.isConnected) continue
    const name = holder.getAttribute('data-lucide') ?? ''
    const stroke = parseFloat(holder.getAttribute('data-stroke-width') ?? '') || 2
    const template = doc.createElement('template')
    template.innerHTML = render(name, stroke)
    const svg = template.content.firstElementChild
    if (!svg) continue
    // Lucide's own classes would only clutter exports; the placeholder's win.
    svg.removeAttribute('class')
    for (const attr of Array.from(holder.attributes)) svg.setAttribute(attr.name, attr.value)
    holder.replaceWith(svg)
  }
  return true
}
