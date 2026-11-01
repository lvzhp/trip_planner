import { create } from 'zustand'
import { api, streamChat, type SendMessageBody } from '../api/client'
import { toast } from '../lib/toast'
import type {
  AskUserAnswer,
  CandidatePlace,
  Constraints,
  ContextTag,
  Derived,
  DiffEntry,
  ModelSelection,
  PlanPatchPayload,
  RouteLeg,
  SseEvent,
  Trip,
  TripDetail,
} from '../types'

interface TripState {
  tripId: string | null
  trip: Trip | null
  derived: Derived | null
  events: SseEvent[]
  lastSeq: number
  readonly: boolean
  loading: boolean
  error: string | null
  sending: boolean
  sendError: string | null
  diffTags: Record<string, string>
  changedDays: number[]
  diffNonce: number
  hydratedAt: number
  /** 距离行（§5）：相邻 stop 的路程。来源是服务端 route_legs + 行程派生。 */
  routeLegs: RouteLeg[]
  /** 正在重算的段（拖拽/加地点后显示「计算中」） */
  legsPending: { fromStopId: string; toStopId: string } | null
  /** 重算失败/未覆盖的段（显示「待更新」） */
  legsStale: string[]
  hydrate: (tripId: string, readonly?: boolean) => Promise<void>
  sync: () => Promise<void>
  adoptDetail: (detail: TripDetail) => void
  refreshLegs: () => Promise<void>
  addPlace: (place: CandidatePlace, dayIndex: number, opts?: { silent?: boolean }) => Promise<string | null>
  removeStop: (stopId: string, opts?: { silent?: boolean }) => Promise<boolean>
  reorderDay: (dayIndex: number, stopIds: string[], opts?: { silent?: boolean }) => Promise<boolean>
  updateConstraints: (
    body: {
      destination?: string | null
      origin?: string | null
      startDate?: string | null
      endDate?: string | null
      travelers?: number | null
      budget?: number | null
      pace?: 'relaxed' | 'normal' | 'packed' | null
      syncDays?: 'shift' | 'trim' | null
    },
    opts?: { silent?: boolean },
  ) => Promise<boolean>
  applyEvent: (event: SseEvent, live?: boolean) => void
  send: (body: SendMessageBody) => Promise<void>
  stop: () => void
  clearDiff: () => void
  reset: () => void
}

function legsFromPayload(payload: any): RouteLeg[] | null {
  const legs = payload?.routeLegs
  return Array.isArray(legs) ? (legs as RouteLeg[]) : null
}

let controller: AbortController | null = null

function diffToTags(diff: DiffEntry[], trip: Trip): { tags: Record<string, string>; days: number[] } {
  const tags: Record<string, string> = {}
  const days = new Set<number>()
  const findStopByActivity = (activityId?: string): { stopId: string; dayIndex: number } | null => {
    if (!activityId) return null
    for (const day of trip.days) {
      for (const stop of day.stops) {
        if (stop.activities.some(a => a.activityId === activityId)) {
          return { stopId: stop.stopId, dayIndex: day.dayIndex }
        }
      }
    }
    return null
  }
  for (const entry of diff) {
    if (entry.dayIndex != null) days.add(entry.dayIndex)
    if (entry.stopId) {
      tags[entry.stopId] = entry.label || (entry.op === 'add' ? '新增' : '已修改')
      continue
    }
    if (entry.field === 'rhythm' && entry.dayIndex != null) {
      const day = trip.days.find(d => d.dayIndex === entry.dayIndex)
      if (day?.stops[0]) tags[day.stops[0].stopId] = entry.label || `${entry.before} → ${entry.after}`
      continue
    }
    const found = findStopByActivity(entry.activityId)
    if (found) {
      tags[found.stopId] = entry.label || (entry.op === 'add' ? '新增' : '已修改')
      days.add(found.dayIndex)
    }
  }
  return { tags, days: [...days] }
}

export const useTripStore = create<TripState>((set, get) => ({
  tripId: null,
  trip: null,
  derived: null,
  events: [],
  lastSeq: 0,
  readonly: false,
  loading: false,
  error: null,
  sending: false,
  sendError: null,
  diffTags: {},
  changedDays: [],
  diffNonce: 0,
  hydratedAt: 0,
  routeLegs: [],
  legsPending: null,
  legsStale: [],

  hydrate: async (tripId, readonly = false) => {
    controller?.abort()
    controller = null
    set({
      tripId,
      loading: true,
      error: null,
      readonly,
      trip: null,
      derived: null,
      events: [],
      lastSeq: 0,
      diffTags: {},
      changedDays: [],
      sendError: null,
      sending: false,
      routeLegs: [],
      legsPending: null,
      legsStale: [],
    })
    try {
      const detail: TripDetail = readonly ? await api.share(tripId) : await api.trip(tripId)
      set({
        trip: detail.trip,
        derived: detail.derived,
        events: detail.events,
        routeLegs: detail.routeLegs || [],
        lastSeq: detail.lastSeq,
        readonly: detail.readonly || readonly,
        loading: false,
        hydratedAt: Date.now(),
      })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  sync: async () => {
    const { tripId, readonly, lastSeq } = get()
    if (!tripId) return
    try {
      const detail = readonly ? await api.share(tripId) : await api.trip(tripId)
      const fresh = await api.eventsAfter(tripId, lastSeq)
      const known = new Set(get().events.map(e => e.seq))
      const merged = [...get().events, ...fresh.events.filter(e => !known.has(e.seq))].sort(
        (a, b) => a.seq - b.seq,
      )
      set({
        trip: detail.trip,
        derived: detail.derived,
        events: merged,
        routeLegs: detail.routeLegs || get().routeLegs,
        lastSeq: Math.max(detail.lastSeq, fresh.lastSeq, lastSeq),
      })
    } catch {
      /* silent sync */
    }
  },

  adoptDetail: detail => {
    set({
      trip: detail.trip,
      derived: detail.derived,
      events: detail.events,
      routeLegs: detail.routeLegs || get().routeLegs,
      lastSeq: detail.lastSeq,
      readonly: detail.readonly || get().readonly,
    })
  },

  refreshLegs: async () => {
    const { tripId } = get()
    if (!tripId) return
    try {
      const data = await api.refreshRoutes(tripId)
      set({ routeLegs: data.legs || [], legsPending: null })
      if (data.message) toast(data.message, 'info')
    } catch (err) {
      // 失败保留旧值，但明确标「待更新」，不做静默成功
      set(state => ({
        legsPending: null,
        legsStale: [...new Set([...state.legsStale, state.legsPending ? `${state.legsPending.fromStopId}__${state.legsPending.toStopId}` : ''])].filter(Boolean),
      }))
      toast(err instanceof Error ? err.message : '距离重算失败，旧值已保留并标记待更新', 'xCircle')
    }
  },

  addPlace: async (place, dayIndex, opts = {}) => {
    const { tripId, trip, readonly } = get()
    if (!tripId || readonly) return null
    const beforeIds = new Set((trip?.days || []).flatMap(d => d.stops.map(s => s.stopId)))
    try {
      const detail = await api.addStop(tripId, {
        dayIndex,
        name: place.name,
        category: place.category,
        city: place.city,
        address: place.address,
        lat: place.lat,
        lng: place.lng,
        amapPoiId: place.poiId && !place.poiId.startsWith('q:') ? place.poiId : null,
        sourceRef: place.added ? null : `poi:user:${place.poiId}`,
      })
      get().adoptDetail(detail)
      void get().refreshLegs()
      const newStop = (detail.trip.days[dayIndex - 1]?.stops || []).find(s => !beforeIds.has(s.stopId))
      if (!opts.silent) {
        toast(`已加入 Day ${dayIndex}`, 'checkCircle', {
          action: newStop
            ? { label: '撤销', onClick: () => void get().removeStop(newStop.stopId, { silent: true }) }
            : undefined,
        })
      }
      return newStop?.stopId ?? null
    } catch (err) {
      toast(err instanceof Error ? err.message : '加入失败，已回滚', 'xCircle')
      return null
    }
  },

  removeStop: async (stopId, opts = {}) => {
    const { tripId, readonly } = get()
    if (!tripId || readonly) return false
    try {
      const detail = await api.deleteStop(tripId, stopId)
      get().adoptDetail(detail)
      void get().refreshLegs()
      if (!opts.silent) toast('已移出行程', 'info')
      return true
    } catch (err) {
      toast(err instanceof Error ? err.message : '移出失败', 'xCircle')
      return false
    }
  },

  reorderDay: async (dayIndex, stopIds, opts = {}) => {
    const { tripId, trip, readonly } = get()
    if (!tripId || readonly) return false
    const previous = (trip?.days.find(d => d.dayIndex === dayIndex)?.stops || []).map(s => s.stopId)
    set({ legsPending: { fromStopId: stopIds[0] || '', toStopId: stopIds[stopIds.length - 1] || '' } })
    try {
      const detail = await api.reorderStops(tripId, dayIndex, stopIds)
      get().adoptDetail(detail)
      await get().refreshLegs()
      if (!opts.silent) {
        toast(`Day ${dayIndex} 顺序已更新`, 'checkCircle', {
          action: previous.length ? { label: '撤销', onClick: () => void get().reorderDay(dayIndex, previous, { silent: true }) } : undefined,
        })
      }
      return true
    } catch (err) {
      set({ legsPending: null })
      toast(err instanceof Error ? err.message : '重排失败', 'xCircle')
      return false
    }
  },

  updateConstraints: async (body, opts = {}) => {
    const { tripId, trip, readonly } = get()
    if (!tripId || readonly) return false
    const before: Constraints | undefined = trip?.constraints
    try {
      const detail = await api.patchConstraints(tripId, body)
      get().adoptDetail(detail)
      if (!opts.silent) {
        const undo: Record<string, any> = {}
        if (body.travelers != null) undo.travelers = before?.travelers ?? null
        if (body.budget != null) undo.budget = before?.budget?.total ?? null
        if (body.destination != null) undo.destination = before?.destination ?? null
        if (body.startDate != null || body.endDate != null) {
          undo.startDate = before?.dateRange?.start ?? null
          undo.endDate = before?.dateRange?.end ?? null
          undo.syncDays = 'shift'
        }
        const hasUndo = Object.keys(undo).length > 0
        toast('行程参数已更新', 'checkCircle', {
          action: hasUndo ? { label: '撤销', onClick: () => void get().updateConstraints(undo, { silent: true }) } : undefined,
        })
      }
      return true
    } catch (err) {
      toast(err instanceof Error ? err.message : '参数更新失败', 'xCircle')
      return false
    }
  },

  applyEvent: (event, live = true) => {
    if (event.seq > 0 && get().events.some(e => e.seq === event.seq)) return
    const nextEvents = [...get().events, event]
    const patch: Partial<TripState> = {
      events: nextEvents,
      lastSeq: Math.max(get().lastSeq, event.seq || 0),
    }
    if (live && event.type === 'plan_patch') {
      const payload = event.payload as unknown as PlanPatchPayload
      if (payload?.trip && payload?.derived) {
        const { tags, days } = diffToTags(payload.diff || [], payload.trip)
        patch.trip = payload.trip
        patch.derived = payload.derived
        patch.diffTags = { ...get().diffTags, ...tags }
        patch.changedDays = days
        patch.diffNonce = get().diffNonce + 1
        const legs = legsFromPayload(payload)
        if (legs) {
          // plan_patch 不带 polyline（避免事件流膨胀）：保留同一 leg 的已有几何
          const previous = get().routeLegs
          patch.routeLegs = legs.map(leg => {
            const old = previous.find(item => item.legId === leg.legId)
            return old?.polyline ? { ...leg, polyline: old.polyline } : leg
          })
        }
      }
    }
    if (live && event.type === 'route') {
      const payload = event.payload || {}
      if (payload.legId) {
        const legs = [...get().routeLegs]
        const index = legs.findIndex(leg => leg.legId === payload.legId)
        const next: RouteLeg = {
          legId: payload.legId,
          fromStopId: payload.fromStopId,
          toStopId: payload.toStopId,
          mode: payload.mode || 'drive',
          distanceM: payload.distanceM ?? null,
          durationMin: payload.durationMin ?? null,
          source: payload.source ?? null,
        }
        if (index >= 0) legs[index] = { ...legs[index], ...next }
        else legs.push(next)
        patch.routeLegs = legs
      }
    }
    set(patch)
  },

  send: async body => {
    const { tripId, sending } = get()
    if (!tripId || sending) return
    controller = new AbortController()
    set({ sending: true, sendError: null })
    try {
      await streamChat(tripId, body, {
        signal: controller.signal,
        onEvent: event => get().applyEvent(event, true),
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        set({ sending: false })
        return
      }
      set({ sendError: err instanceof Error ? err.message : String(err) })
      // Network blip: pull missed events, then the user can retry.
      await get().sync()
    } finally {
      controller = null
      set({ sending: false })
    }
  },

  stop: () => {
    controller?.abort()
    controller = null
    set({ sending: false })
  },

  clearDiff: () => set({ diffTags: {}, changedDays: [] }),

  reset: () =>
    set({
      tripId: null,
      trip: null,
      derived: null,
      events: [],
      lastSeq: 0,
      loading: false,
      error: null,
      sending: false,
      sendError: null,
      diffTags: {},
      changedDays: [],
      readonly: false,
      routeLegs: [],
      legsPending: null,
      legsStale: [],
    }),
}))

/** Convenience selectors used across components. */
export function useTrip() {
  return useTripStore(s => s.trip)
}
export function useDerived() {
  return useTripStore(s => s.derived)
}

export type { AskUserAnswer, ContextTag, ModelSelection }
