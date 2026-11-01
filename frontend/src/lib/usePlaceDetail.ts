import { useCallback, useEffect, useState } from 'react'
import { getPlace, mergeCandidate } from '../api/places'
import { useTripStore } from '../stores/tripStore'
import type { CandidatePlace, PlaceDetail, PlaceSegment } from '../types'

function segmentToCandidate(segment?: PlaceSegment | null): CandidatePlace {
  return {
    poiId: segment?.poiId || '',
    name: segment?.fullName || segment?.name || '未命名地点',
    category: segment?.category || 'place',
    lat: segment?.lat ?? null,
    lng: segment?.lng ?? null,
    city: segment?.city ?? null,
    address: segment?.address ?? null,
    source: 'chat',
    added: !!segment?.added,
    stopId: segment?.stopId ?? null,
    dayIndex: segment?.dayIndex ?? null,
  }
}

/**
 * 浮卡详情：先请求服务端（高德 + 7d 缓存），失败时仍用消息 segment 里的真实字段
 * 渲染（至少名称/分类/城市/坐标是可信的），并保留错误状态给「重试」。
 */
export function usePlaceDetail(poiId: string | null, segment?: PlaceSegment | null) {
  const tripId = useTripStore(s => s.tripId)
  const [detail, setDetail] = useState<PlaceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!poiId) {
      setDetail(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    const fallback = mergeCandidate(null, segmentToCandidate(segment))
    setDetail(prev => prev?.poiId === poiId ? prev : fallback)
    getPlace(poiId, { tripId, force: nonce > 0 })
      .then(value => {
        if (!alive) return
        setDetail(mergeCandidate(value, segmentToCandidate(segment)))
      })
      .catch(err => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
        setDetail(prev => prev ?? fallback)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [poiId, tripId, nonce, segment])

  const retry = useCallback(() => setNonce(n => n + 1), [])
  return { detail, loading, error, retry }
}
