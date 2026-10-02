import { create } from 'zustand'
import type { ModelOption } from '../../../shared/contracts'
import { api } from '../api'

/** The model catalog, fetched once and shared by every view that names models. */
export const useModels = create<{ models: ModelOption[]; loaded: boolean; load: () => Promise<void> }>(
  (set, get) => ({
    models: [],
    loaded: false,
    async load() {
      if (get().loaded) return
      set({ loaded: true })
      const res = await api.models()
      if (res.ok) set({ models: res.data.models })
      else set({ loaded: false })
    }
  })
)

const VENDOR_BY_PREFIX: Record<string, string> = {
  nvidia: 'NVIDIA',
  'zai-org': 'Z.ai',
  'deepseek-ai': 'DeepSeek',
  moonshotai: 'Moonshot'
}

/** A label and vendor for any model id, catalogued or not. */
export function describeModel(id: string, models: ModelOption[]): { label: string; vendor: string } {
  const known = models.find((m) => m.id === id)
  if (known) return { label: known.label, vendor: known.vendor }
  const [prefix, name] = id.includes('/') ? id.split('/', 2) : ['', id]
  return {
    label: (name || id).replace(/[-_]/g, ' '),
    vendor: VENDOR_BY_PREFIX[prefix.toLowerCase()] ?? prefix
  }
}
