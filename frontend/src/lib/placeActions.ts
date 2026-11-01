import { useCallback } from 'react'
import { api } from '../api/client'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import type { CandidatePlace, PlaceDetail, PlaceSegment } from '../types'
import { focusPlaceOnMap } from './mapBridge'
import { isTouchSurface } from './placeMeta'

/** chip / 浮卡 / 候选点 / 收藏共用的地点动作：定位、加入、移出、确认位置。 */
export function usePlaceActions() {
  const trip = useTripStore(s => s.trip)
  const readonly = useTripStore(s => s.readonly)
  const addPlace = useTripStore(s => s.addPlace)
  const removeStop = useTripStore(s => s.removeStop)
  const updateStopPoi = useCallback(
    async (
      stopId: string,
      patch: {
        name?: string
        city?: string | null
        address?: string | null
        lat?: number | null
        lng?: number | null
        amapPoiId?: string | null
        sourceRef?: string | null
      },
    ) => {
      const { tripId, adoptDetail } = useTripStore.getState()
      if (!tripId) return false
      try {
        const detail = await api.updateStopPoi(tripId, stopId, patch)
        adoptDetail(detail)
        return true
      } catch {
        return false
      }
    },
    [],
  )

  const defaultDay = useCallback((): number => {
    const activeDay = useUiStore.getState().activeDay
    const days = trip?.days || []
    if (days.some(day => day.dayIndex === activeDay)) return activeDay
    return days.length ? days[days.length - 1].dayIndex : 1
  }, [trip])

  /** 点 chip / 候选点：地图 flyTo + 选中 marker + 打开浮卡（对话不滚动）。 */
  const openPlaceAt = useCallback(
    (segment: PlaceSegment, anchorEl?: HTMLElement | null) => {
      const state = useUiStore.getState()
      const rect = anchorEl?.getBoundingClientRect()
      state.openPlace(segment.poiId, {
        segment,
        mode: isTouchSurface() ? 'sheet' : 'popover',
        origin: 'chip',
        anchor: rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null,
      })
      if (anchorEl) useUiStore.setState({ placeReturnFocus: anchorEl })
      if (segment.stopId) {
        state.selectStop(segment.stopId, null, segment.dayIndex ?? undefined)
      }
      if (segment.hasCoords) focusPlaceOnMap(segment.poiId, 14)
    },
    [],
  )

  const openPlaceId = useCallback((poiId: string, opts: { anchorEl?: HTMLElement | null; origin?: 'candidate' | 'saved' | 'card' } = {}) => {
    const state = useUiStore.getState()
    const rect = opts.anchorEl?.getBoundingClientRect()
    state.openPlace(poiId, {
      mode: isTouchSurface() ? 'sheet' : 'popover',
      origin: opts.origin ?? 'candidate',
      anchor: rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null,
    })
    focusPlaceOnMap(poiId, 14)
  }, [])

  /** 加入第 N 天（chip 的 ＋ 与浮卡主按钮共用同一条路径）。 */
  const addSegment = useCallback(
    async (segment: PlaceSegment, dayIndex?: number): Promise<string | null> => {
      if (readonly) return null
      if (segment.added) return segment.stopId ?? null
      if (segment.missing || !segment.hasCoords) return null
      const state = useUiStore.getState()
      const day = dayIndex ?? defaultDay()
      state.setPendingAdd(segment.poiId, true)
      state.markCandidateAdded(segment.poiId, true, { dayIndex: day })
      try {
        const candidate: CandidatePlace = {
          poiId: segment.poiId,
          name: segment.fullName || segment.name,
          category: segment.category,
          lat: segment.lat ?? null,
          lng: segment.lng ?? null,
          city: segment.city ?? null,
          address: segment.address ?? null,
          source: 'chat',
          added: true,
        }
        const stopId = await addPlace(candidate, day)
        if (stopId) {
          state.markCandidateAdded(segment.poiId, true, { stopId, dayIndex: day })
          state.removeCandidate(segment.poiId)
        } else {
          state.markCandidateAdded(segment.poiId, false)
        }
        return stopId
      } finally {
        state.setPendingAdd(segment.poiId, false)
      }
    },
    [addPlace, defaultDay, readonly],
  )

  const addCandidate = useCallback(
    async (candidate: CandidatePlace, dayIndex?: number): Promise<string | null> => {
      if (readonly) return null
      const state = useUiStore.getState()
      const day = dayIndex ?? defaultDay()
      state.setPendingAdd(candidate.poiId, true)
      try {
        const stopId = await addPlace(candidate, day)
        if (stopId) {
          state.markCandidateAdded(candidate.poiId, true, { stopId, dayIndex: day })
          state.removeCandidate(candidate.poiId)
        }
        return stopId
      } finally {
        state.setPendingAdd(candidate.poiId, false)
      }
    },
    [addPlace, defaultDay, readonly],
  )

  /** 浮卡「加入第 N 天」：地点来自 trip 时不会再走插入分支。 */
  const addDetail = useCallback(
    async (detail: PlaceDetail, dayIndex?: number): Promise<string | null> => {
      if (detail.inTrip && detail.stopId) return detail.stopId
      return addCandidate(
        {
          poiId: detail.poiId,
          name: detail.name,
          category: detail.category,
          lat: detail.lat ?? null,
          lng: detail.lng ?? null,
          city: detail.city ?? null,
          address: detail.address ?? null,
          source: 'chat',
        },
        dayIndex,
      )
    },
    [addCandidate],
  )

  const removeFromTrip = useCallback(
    async (stopId: string | null | undefined) => {
      if (!stopId || readonly) return false
      return removeStop(stopId)
    },
    [readonly, removeStop],
  )

  return {
    readonly,
    defaultDay,
    openPlaceAt,
    openPlaceId,
    addSegment,
    addCandidate,
    addDetail,
    removeFromTrip,
    updateStopPoi,
  }
}
