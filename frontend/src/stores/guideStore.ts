import { create } from 'zustand'
import { api, streamGuide } from '../api/client'
import type { GuideStageKind, ModelSelection, StopGuide } from '../types'

/**
 * 攻略层前端状态（docs/07 §9）。
 *
 * 服务端已有 3 天磁盘缓存（cache key 含 poi_hash/filter_hash/profile_hash），
 * 这里只加一层会话内内存缓存避免同一 stop 反复重连 SSE。
 * 生成是 lazy 的：只在用户打开美食/打卡段时触发。
 */

interface GuideEntry {
  status: 'idle' | 'loading' | 'ready' | 'error'
  stage: GuideStageKind | null
  label: string
  guide: StopGuide | null
  error: string | null
}

interface GuideState {
  /** key = stopId + '|' + filters.join(',') */
  entries: Record<string, GuideEntry>
  controllers: Record<string, AbortController>
  load: (
    tripId: string,
    stopId: string,
    opts: { filters?: string[]; refresh?: boolean; readonly?: boolean; model?: ModelSelection | null },
  ) => Promise<void>
  cancel: (stopId: string, filters?: string[]) => void
  reset: () => void
}

/** 内存缓存 key 与服务端 cache key 同构：stopId + 排序后的 filters。 */
export const entryKey = (stopId: string, filters: string[] = []) => `${stopId}|${[...filters].sort().join(',')}`

const IDLE: GuideEntry = { status: 'idle', stage: null, label: '', guide: null, error: null }

export const useGuideStore = create<GuideState>((set, get) => ({
  entries: {},
  controllers: {},

  load: async (tripId, stopId, opts = {}) => {
    const filters = opts.filters || []
    const key = entryKey(stopId, filters)
    const current = get().entries[key] || IDLE
    if (!opts.refresh && current.status === 'ready') return
    if (current.status === 'loading') return

    // 分享页：只读缓存，绝不触发生成（docs/07 §10）
    if (opts.readonly) {
      set(s => ({ entries: { ...s.entries, [key]: { ...IDLE, status: 'loading', label: '读取攻略…' } } }))
      try {
        const resp = await api.shareGuide(tripId, stopId, filters)
        set(s => ({
          entries: {
            ...s.entries,
            [key]: resp.available && resp.guide
              ? { status: 'ready', stage: 'done', label: '', guide: resp.guide, error: null }
              : { ...IDLE, status: 'error', error: 'unavailable' },
          },
        }))
      } catch {
        set(s => ({ entries: { ...s.entries, [key]: { ...IDLE, status: 'error', error: 'unavailable' } } }))
      }
      return
    }

    const controller = new AbortController()
    set(s => ({
      entries: { ...s.entries, [key]: { ...IDLE, status: 'loading', stage: 'searching', label: '正在检索周边…' } },
      controllers: { ...s.controllers, [key]: controller },
    }))
    try {
      await streamGuide(
        tripId,
        stopId,
        { filters, refresh: opts.refresh, model: opts.model, signal: controller.signal },
        stage => {
          if (stage.stage === 'done' && stage.detail) {
            set(s => ({
              entries: {
                ...s.entries,
                [key]: { status: 'ready', stage: 'done', label: '', guide: stage.detail!, error: null },
              },
            }))
          } else if (stage.stage === 'error') {
            set(s => ({
              entries: {
                ...s.entries,
                [key]: {
                  status: 'error',
                  stage: 'error',
                  label: stage.label || '',
                  guide: stage.detail || null,
                  error: stage.error || '生成失败',
                },
              },
            }))
          } else {
            set(s => ({
              entries: {
                ...s.entries,
                [key]: {
                  ...(s.entries[key] || IDLE),
                  status: 'loading',
                  stage: stage.stage,
                  label: stage.label || '',
                },
              },
            }))
          }
        },
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      set(s => ({
        entries: {
          ...s.entries,
          [key]: { ...IDLE, status: 'error', error: err instanceof Error ? err.message : String(err) },
        },
      }))
    } finally {
      set(s => {
        const { [key]: _done, ...rest } = s.controllers
        return { controllers: rest }
      })
    }
  },

  cancel: (stopId, filters = []) => {
    const key = entryKey(stopId, filters)
    get().controllers[key]?.abort()
  },

  reset: () => {
    for (const c of Object.values(get().controllers)) c.abort()
    set({ entries: {}, controllers: {} })
  },
}))

export { entryKey as guideEntryKey }
