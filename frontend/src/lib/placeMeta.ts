import type { PlaceCategory } from '../types'

/** 分类 → 图标（emoji 兜底，不依赖新图标包；chip 里 13px、marker 里 14px）。 */
export const PLACE_CATEGORY_META: Record<PlaceCategory, { icon: string; label: string }> = {
  stay: { icon: '🛏', label: '住宿' },
  meal: { icon: '🍴', label: '餐饮' },
  sight: { icon: '📷', label: '景点' },
  shopping: { icon: '🛍', label: '购物' },
  transit: { icon: '🚉', label: '交通' },
  place: { icon: '📍', label: '地点' },
  unknown: { icon: '!', label: '未定位' },
}

export function placeIcon(category?: string | null): string {
  return PLACE_CATEGORY_META[(category as PlaceCategory) || 'place']?.icon || '📍'
}

export function placeCategoryLabel(category?: string | null): string {
  return PLACE_CATEGORY_META[(category as PlaceCategory) || 'place']?.label || '地点'
}

const MODE_META: Record<string, { icon: string; label: string }> = {
  walk: { icon: '🚶', label: '步行' },
  bike: { icon: '🚲', label: '骑行' },
  drive: { icon: '🚗', label: '驾车' },
  transit: { icon: '🚌', label: '公共交通' },
  train: { icon: '🚆', label: '火车' },
  flight: { icon: '✈', label: '航班' },
  ferry: { icon: '⛴', label: '轮渡' },
}

export function modeMeta(mode?: string | null) {
  return MODE_META[mode || 'drive'] || MODE_META.drive
}

/** `1.2 km` / `850 m`；没有距离就不给数字。 */
export function fmtDistance(distanceM?: number | null): string | null {
  if (distanceM == null || Number.isNaN(distanceM)) return null
  if (distanceM < 1000) return `${Math.round(distanceM)} m`
  const km = distanceM / 1000
  return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km`
}

/** `18 分钟` / `1h45m`（航班火车用长格式）。 */
export function fmtDuration(durationMin?: number | null): string | null {
  if (durationMin == null || Number.isNaN(durationMin)) return null
  const mins = Math.max(1, Math.round(durationMin))
  if (mins < 60) return `${mins} 分钟`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h${String(m).padStart(2, '0')}m` : `${h} 小时`
}

/** 距离行文案：`🚶 1.2 km · 18 分钟` / `距离待算`。 */
export function legLine(leg?: {
  mode?: string | null
  distanceM?: number | null
  durationMin?: number | null
} | null): string {
  if (!leg) return '距离待算'
  const meta = modeMeta(leg.mode)
  const distance = fmtDistance(leg.distanceM)
  const duration = fmtDuration(leg.durationMin)
  if (!distance && !duration) return '距离待算'
  // 图标跟第一段用空格，其余用 · ：`🚗 148 km · 2h25m`
  const rest = [distance, duration].filter(Boolean).join(' · ')
  return rest ? `${meta.icon} ${rest}` : meta.icon
}

export function sourceAgeDays(fetchedAt?: string | null): number | null {
  if (!fetchedAt) return null
  const then = new Date(fetchedAt)
  if (Number.isNaN(then.getTime())) return null
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000))
}

export function fmtRating(rating?: number | null): string | null {
  if (rating == null || Number.isNaN(rating)) return null
  return rating.toFixed(1)
}

export function fmtFetchedAt(fetchedAt?: string | null): string {
  if (!fetchedAt) return ''
  const date = new Date(fetchedAt)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function isTouchSurface(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(hover: none), (pointer: coarse)').matches
}
