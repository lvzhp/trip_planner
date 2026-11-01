import { ApiError, api } from './client'
import type { CandidatePlace, PlaceDetail } from '../types'

/**
 * 浮卡详情（mindtrip/06 §2.4）：60s 内存缓存 + 同 id 并发去重。
 *
 * 高德详情 7 天在服务端缓存，这里只挡掉 hover 反复进出造成的重复请求。
 * 缓存值会保留 `missing`，所以「暂无」也是真实结论，不会一刷新就变成有数据。
 */
const TTL = 60_000
const cache = new Map<string, { at: number; value: PlaceDetail }>()
const inflight = new Map<string, Promise<PlaceDetail>>()

export function clearPlaceCache(poiId?: string) {
  if (poiId) {
    cache.delete(poiId)
    return
  }
  cache.clear()
}

export async function getPlace(poiId: string, opts: { tripId?: string | null; force?: boolean } = {}): Promise<PlaceDetail> {
  const key = `${opts.tripId || ''}::${poiId}`
  if (!opts.force) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL) return hit.value
    const pending = inflight.get(key)
    if (pending) return pending
  }
  const task = api
    .place(poiId, opts.tripId)
    .then(value => {
      cache.set(key, { at: Date.now(), value })
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

/** 候选点补位：详情拿不到/字段缺失时，用候选已带的真实字段填充（不编造）。 */
export function mergeCandidate(base: PlaceDetail | null, candidate: CandidatePlace): PlaceDetail {
  const fallback: PlaceDetail = {
    poiId: candidate.poiId,
    name: candidate.name || '未命名地点',
    category: candidate.category || 'place',
    city: candidate.city ?? null,
    address: candidate.address ?? null,
    lat: candidate.lat ?? null,
    lng: candidate.lng ?? null,
    photos: [],
    missing: [],
    stopId: candidate.stopId ?? null,
    dayIndex: candidate.dayIndex ?? null,
    inTrip: !!candidate.added,
  }
  if (!base) return fallback
  return {
    ...fallback,
    ...base,
    poiId: base.poiId || fallback.poiId,
    name: base.name || fallback.name,
    category: base.category || fallback.category,
    city: base.city ?? fallback.city,
    address: base.address ?? fallback.address,
    lat: base.lat ?? fallback.lat,
    lng: base.lng ?? fallback.lng,
    stopId: base.stopId ?? fallback.stopId,
    dayIndex: base.dayIndex ?? fallback.dayIndex,
    inTrip: base.inTrip ?? fallback.inTrip,
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError ? err.status === 404 : false
}
