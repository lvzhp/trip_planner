import { create } from 'zustand'
import { api } from '../api/client'
import type { AppConfig } from '../types'

interface AppState {
  config: AppConfig | null
  configError: string | null
  loadConfig: (force?: boolean) => Promise<AppConfig | null>
  refreshConfig: () => Promise<AppConfig | null>
}

export const useAppStore = create<AppState>((set, get) => ({
  config: null,
  configError: null,
  loadConfig: async (force = false) => {
    if (!force && get().config) return get().config
    try {
      const config = await api.config()
      set({ config, configError: null })
      return config
    } catch (err) {
      set({ configError: err instanceof Error ? err.message : String(err) })
      return null
    }
  },
  refreshConfig: async () => get().loadConfig(true),
}))
