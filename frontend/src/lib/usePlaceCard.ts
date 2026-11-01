import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { usePlaceDetail } from './usePlaceDetail'
import { usePlaceActions } from './placeActions'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { usePlaceStore } from '../stores/placeStore'
import { openAmap } from './nav'
import { toast } from './toast'
import type { CandidatePlace, PlaceSegment } from '../types'
import { storageGet, storageSet } from '../platform/storage'

const FEEDBACK_KEY = 'tp:placeFeedback'

function readFeedback(): Record<string, 'up' | 'down'> {
  try {
    const raw = storageGet(FEEDBACK_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** 浮卡 / Sheet 共用的数据与动作（mindtrip/06 §2.2、§2.5）。 */
export function usePlaceCard() {
  const card = useUiStore(s => s.placeCard)
  const closePlace = useUiStore(s => s.closePlace)
  const activeDay = useUiStore(s => s.activeDay)
  const trip = useTripStore(s => s.trip)
  const readonly = useTripStore(s => s.readonly)
  const { detail, loading, error, retry } = usePlaceDetail(card?.poiId ?? null, card?.segment ?? null)
  const { addDetail, addCandidate, removeFromTrip, updateStopPoi, defaultDay, readonly: actionReadonly } = usePlaceActions()
  const saved = usePlaceStore(s => s.isSaved(card?.poiId ?? ''))
  const toggleSaved = usePlaceStore(s => s.toggle)
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 'up' | 'down'>>(() => readFeedback())
  const [fullOpen, setFullOpen] = useState(false)
  const [locateOpen, setLocateOpen] = useState(false)
  const [locating, setLocating] = useState(false)
  const [locateQuery, setLocateQuery] = useState('')
  const [locateResults, setLocateResults] = useState<CandidatePlace[]>([])
  const [locateMessage, setLocateMessage] = useState<string | null>(null)

  useEffect(() => {
    setFullOpen(false)
    setLocateOpen(false)
    setLocateResults([])
    setLocateQuery('')
    setLocateMessage(null)
  }, [card?.poiId])

  const dayOptions = useMemo(
    () =>
      (trip?.days || []).map(day => ({
        dayIndex: day.dayIndex,
        label: ` Day ${day.dayIndex}`,
      })),
    [trip?.days],
  )

  const day = defaultDay()
  // 行程文档是唯一事实：加入/移出后浮卡状态立刻跟着变（而不是等重新请求详情）
  const live = useMemo(() => {
    if (!trip || !detail) return null
    for (const tripDay of trip.days) {
      for (const stop of tripDay.stops) {
        if (
          (detail.stopId && stop.stopId === detail.stopId) ||
          (stop.poi.amapPoiId && (stop.poi.amapPoiId === detail.poiId || stop.stopId === detail.poiId))
        ) {
          return { dayIndex: tripDay.dayIndex, stopId: stop.stopId }
        }
      }
    }
    return null
  }, [trip, detail])
  const liveDetail = detail
    ? {
        ...detail,
        inTrip: !!live,
        stopId: live?.stopId ?? detail.stopId,
        dayIndex: live?.dayIndex ?? detail.dayIndex,
      }
    : null
  // 已在行程的点：默认「加入/移出」上下文是它所在的天；候选点用当前选中的天
  const cardDay = liveDetail?.dayIndex ?? day
  const feedback = feedbackMap[card?.poiId || ''] ?? null

  const onAdd = useCallback(
    async (dayIndex: number) => {
      if (!detail) return
      await addDetail(detail, dayIndex)
    },
    [addDetail, detail],
  )

  const onRemove = useCallback(async () => {
    if (!detail?.stopId) return
    await removeFromTrip(detail.stopId)
  }, [detail?.stopId, removeFromTrip])

  const onNavigate = useCallback(() => {
    if (!detail || detail.lat == null || detail.lng == null) {
      setLocateOpen(true)
      return
    }
    openAmap({ name: detail.name, lng: detail.lng, lat: detail.lat }, trip?.constraints.transportMode)
  }, [detail, trip?.constraints.transportMode])

  const onToggleSave = useCallback(() => {
    if (!detail) return
    void toggleSaved({
      poiId: detail.poiId,
      name: detail.name,
      category: detail.category,
      lat: detail.lat ?? null,
      lng: detail.lng ?? null,
      city: detail.city ?? null,
      address: detail.address ?? null,
    })
  }, [detail, toggleSaved])

  const onFeedback = useCallback(
    (vote: 'up' | 'down') => {
      if (!detail) return
      const next = { ...feedbackMap, [detail.poiId]: vote }
      setFeedbackMap(next)
      try {
        storageSet(FEEDBACK_KEY, JSON.stringify(next))
      } catch {
        /* ignore quota */
      }
      void api.placeFeedback(detail.poiId, vote).catch(() => undefined)
      toast(vote === 'up' ? '已记录：有用' : '已记录：没用', 'checkCircle')
    },
    [detail, feedbackMap],
  )

  const runLocateSearch = useCallback(async () => {
    const query = locateQuery.trim()
    if (!query) return
    setLocating(true)
    setLocateMessage(null)
    try {
      const result = await api.searchPlaces(
        query,
        detail?.city || trip?.constraints.destination || null,
        8,
        useTripStore.getState().tripId,
      )
      setLocateResults(result.items || [])
      setLocateMessage(result.items?.length ? null : result.message || '没找到，换个关键词试试')
    } catch (err) {
      setLocateMessage(err instanceof Error ? err.message : '搜索失败')
    } finally {
      setLocating(false)
    }
  }, [detail?.city, locateQuery, trip?.constraints.destination])

  const applyLocated = useCallback(
    async (candidate: CandidatePlace) => {
      if (!detail) return
      if (detail.stopId) {
        const ok = await updateStopPoi(detail.stopId, {
          name: candidate.name,
          city: candidate.city ?? null,
          address: candidate.address ?? null,
          lat: candidate.lat ?? null,
          lng: candidate.lng ?? null,
          amapPoiId: candidate.poiId.startsWith('q:') ? null : candidate.poiId,
          sourceRef: candidate.poiId.startsWith('q:') ? null : `poi:amap:${candidate.poiId}`,
        })
        if (!ok) {
          toast('确认位置失败', 'xCircle')
          return
        }
        toast('位置已确认', 'checkCircle')
        retry()
      } else {
        await addCandidate(candidate)
      }
      setLocateOpen(false)
      setLocateResults([])
      setLocateQuery('')
    },
    [addCandidate, detail, retry, updateStopPoi],
  )

  const segment: PlaceSegment | null = card?.segment ?? null

  return {
    card,
    detail: liveDetail,
    loading,
    error,
    segment,
    readonly: readonly || actionReadonly,
    activeDay: cardDay,
    day,
    dayOptions,
    saved,
    feedback,
    fullOpen,
    setFullOpen,
    locateOpen,
    setLocateOpen,
    locating,
    locateQuery,
    setLocateQuery,
    locateResults,
    locateMessage,
    runLocateSearch,
    applyLocated,
    onAdd,
    onRemove,
    onNavigate,
    onToggleSave,
    onFeedback,
    retry,
    closePlace,
  }
}
