/** The palette: ready-made pieces to drag onto a frame. Plain HTML + Tailwind,
 *  the same dialect the agent writes, so they export like everything else. */

export interface PaletteItem {
  name: string
  group: 'Basics' | 'Inputs' | 'Content' | 'Sections' | 'Shapes'
  html: string
}

const icon = (path: string, cls = 'h-5 w-5'): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`

export const PALETTE: PaletteItem[] = [
  { name: 'Heading', group: 'Basics', html: `<h2 class="text-3xl font-semibold tracking-tight text-neutral-900">A clear, confident heading</h2>` },
  { name: 'Paragraph', group: 'Basics', html: `<p class="text-base leading-relaxed text-neutral-600">Supporting copy that explains the idea in a sentence or two, without getting in the way.</p>` },
  { name: 'Button', group: 'Basics', html: `<button class="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white">Get started</button>` },
  { name: 'Outline button', group: 'Basics', html: `<button class="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900">Learn more</button>` },
  { name: 'Badge', group: 'Basics', html: `<span class="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">New</span>` },
  { name: 'Avatar', group: 'Basics', html: `<div class="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900 text-sm font-semibold text-white">AK</div>` },
  { name: 'Divider', group: 'Basics', html: `<div class="h-px w-full bg-neutral-200"></div>` },
  { name: 'Icon', group: 'Basics', html: icon('<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.600 19.500l1.200-6L3.300 9.300l6.100-.7z"/>', 'h-6 w-6 text-neutral-900') },

  { name: 'Text field', group: 'Inputs', html: `<div class="flex w-72 flex-col gap-1.5"><span class="text-sm font-medium text-neutral-800">Email</span><div class="flex h-10 items-center rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-400">you@example.com</div></div>` },
  { name: 'Search', group: 'Inputs', html: `<div class="flex h-10 w-72 items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-400">${icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.500-3.500"/>', 'h-4 w-4')}<span>Search</span></div>` },
  { name: 'Checkbox', group: 'Inputs', html: `<div class="flex items-center gap-2.5"><div class="flex h-5 w-5 items-center justify-center rounded-md bg-neutral-900 text-white">${icon('<path d="M5 12.500l4.500 4.500L19 7.500"/>', 'h-3.5 w-3.5')}</div><span class="text-sm text-neutral-800">Remember me</span></div>` },
  { name: 'Toggle', group: 'Inputs', html: `<div class="flex h-6 w-11 items-center rounded-full bg-neutral-900 p-0.5"><div class="ml-auto h-5 w-5 rounded-full bg-white shadow"></div></div>` },
  { name: 'Tabs', group: 'Inputs', html: `<div class="inline-flex rounded-lg bg-neutral-100 p-1 text-sm font-medium"><span class="rounded-md bg-white px-3 py-1.5 text-neutral-900 shadow-sm">Overview</span><span class="px-3 py-1.5 text-neutral-500">Activity</span><span class="px-3 py-1.5 text-neutral-500">Settings</span></div>` },

  { name: 'Card', group: 'Content', html: `<div class="flex w-80 flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm"><h3 class="text-lg font-semibold text-neutral-900">Card title</h3><p class="text-sm leading-relaxed text-neutral-600">A short description of what this card is about and why it matters.</p><button class="inline-flex h-9 w-fit items-center rounded-lg bg-neutral-900 px-3.5 text-sm font-medium text-white">Open</button></div>` },
  { name: 'Stat', group: 'Content', html: `<div class="flex w-56 flex-col gap-1 rounded-2xl border border-neutral-200 bg-white p-5"><span class="text-sm text-neutral-500">Monthly revenue</span><span class="text-3xl font-semibold tracking-tight text-neutral-900">$48,290</span><span class="text-sm font-medium text-emerald-600">+12.4% vs last month</span></div>` },
  { name: 'List row', group: 'Content', html: `<div class="flex w-80 items-center gap-3 rounded-xl p-3"><div class="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 text-sm font-semibold text-neutral-700">MS</div><div class="flex flex-1 flex-col"><span class="text-sm font-medium text-neutral-900">Maya Singh</span><span class="text-sm text-neutral-500">Sent you the Q3 report</span></div><span class="text-xs text-neutral-400">2m</span></div>` },
  { name: 'Image placeholder', group: 'Content', html: `<div class="flex h-48 w-80 items-center justify-center rounded-2xl bg-neutral-100 text-neutral-400">${icon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>', 'h-8 w-8')}</div>` },
  { name: 'Quote', group: 'Content', html: `<figure class="flex w-96 flex-col gap-4"><blockquote class="text-xl leading-snug font-medium text-neutral-900">“It replaced three tools for us in the first week.”</blockquote><figcaption class="text-sm text-neutral-500">Dana Okafor, Head of Operations</figcaption></figure>` },

  { name: 'Nav bar', group: 'Sections', html: `<header class="flex h-16 w-full items-center justify-between border-b border-neutral-200 bg-white px-6"><span class="text-base font-semibold text-neutral-900">Northwind</span><nav class="flex items-center gap-6 text-sm text-neutral-600"><span>Product</span><span>Pricing</span><span>Docs</span></nav><button class="inline-flex h-9 items-center rounded-lg bg-neutral-900 px-3.5 text-sm font-medium text-white">Sign in</button></header>` },
  { name: 'Hero', group: 'Sections', html: `<section class="flex w-full flex-col items-center gap-5 px-8 py-20 text-center"><span class="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">Now in beta</span><h1 class="max-w-2xl text-5xl font-semibold tracking-tight text-neutral-900">Ship the work that matters, faster</h1><p class="max-w-xl text-lg text-neutral-600">One calm workspace for planning, building and reviewing with your team.</p><div class="flex gap-3"><button class="inline-flex h-11 items-center rounded-lg bg-neutral-900 px-5 text-sm font-medium text-white">Start free</button><button class="inline-flex h-11 items-center rounded-lg border border-neutral-300 px-5 text-sm font-medium text-neutral-900">Book a demo</button></div></section>` },
  { name: 'Tab bar', group: 'Sections', html: `<nav class="flex h-16 w-full items-center justify-around border-t border-neutral-200 bg-white text-neutral-400"><span class="text-neutral-900">${icon('<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/>')}</span><span>${icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.500-3.500"/>')}</span><span>${icon('<path d="M6 9a6 6 0 0 1 12 0c0 6 2.500 7 2.500 7h-17S6 15 6 9"/><path d="M10 20a2 2 0 0 0 4 0"/>')}</span><span>${icon('<circle cx="12" cy="8" r="4"/><path d="M4 20c1.500-4 5-5 8-5s6.500 1 8 5"/>')}</span></nav>` },
  { name: 'Footer', group: 'Sections', html: `<footer class="flex w-full items-center justify-between border-t border-neutral-200 px-6 py-5 text-sm text-neutral-500"><span>© 2026 Northwind</span><div class="flex gap-5"><span>Privacy</span><span>Terms</span><span>Contact</span></div></footer>` },

  { name: 'Rectangle', group: 'Shapes', html: `<div class="h-32 w-48 bg-neutral-300"></div>` },
  { name: 'Rounded', group: 'Shapes', html: `<div class="h-32 w-48 rounded-3xl bg-neutral-300"></div>` },
  { name: 'Circle', group: 'Shapes', html: `<div class="h-32 w-32 rounded-full bg-neutral-300"></div>` },
  { name: 'Gradient blob', group: 'Shapes', html: `<div class="h-48 w-48 rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffb199,#ff0844)] blur-2xl"></div>` },
  { name: 'Line', group: 'Shapes', html: `<div class="h-0.5 w-48 bg-neutral-900"></div>` }
]
