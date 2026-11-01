import { create } from 'zustand'
import { api } from '../api/client'
import { toast } from '../lib/toast'
import type { SavedPlace } from '../types'

/**
 * 收藏 / 想去层（mindtrip/06 §11）。服务端持久化，前端只缓存列表。
 * 收藏是私有数据，不进 Trip、不进分享；加入行程后收藏保留（不自动删）。
 */
interface PlaceState {
  saved: SavedPlace[]
  loading: boolean
  loaded: boolean
  load: () => Promise<void>
  isSaved: (poiId: string) => boolean
  save: (place: Omit<SavedPlace, 'createdAt'>) => Promise<void>
  toggle: (place: Omit<SavedPlace, 'createdAt'>) => Promise<void>
  remove: (poiId: string) => Promise<void>
}

export const usePlaceStore = create<PlaceState>((set, get) => ({
  saved: [],
  loading: false,
  loaded: false,

  load: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const data = await api.saved()
      set({ saved: data.items || [], loaded: true })
    } catch {
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  isSaved: poiId => get().saved.some(item => item.poiId === poiId),

  save: async place => {
    const prev = get().saved
    // 乐观：立刻变心形，失败回滚
    set({ saved: [{ ...place, createdAt: new Date().toISOString() }, ...prev.filter(p => p.poiId !== place.poiId)] })
    try {
      const data = await api.savePlace({
        poiId: place.poiId,
        name: place.name,
        category: place.category ?? null,
        lat: place.lat ?? null,
        lng: place.lng ?? null,
        city: place.city ?? null,
        address: place.address ?? null,
        note: place.note ?? null,
      })
      set({ saved: data.items || [] })
      toast('已加入收藏', 'checkCircle')
    } catch (err) {
      set({ saved: prev })
      toast(err instanceof Error ? err.message : '收藏失败', 'xCircle')
    }
  },

  toggle: async place => {
    if (get().isSaved(place.poiId)) await get().remove(place.poiId)
    else await get().save(place)
  },

  remove: async poiId => {
    const prev = get().saved
    set({ saved: prev.filter(item => item.poiId !== poiId) })
    try {
      const data = await api.removeSaved(poiId)
      set({ saved: data.items || [] })
      toast('已取消收藏', 'info')
    } catch (err) {
      set({ saved: prev })
      toast(err instanceof Error ? err.message : '取消收藏失败', 'xCircle')
    }
  },
}))
