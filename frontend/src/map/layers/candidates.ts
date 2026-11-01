import type { CandidatePlace } from '../../types'

/** 候选层聚合（mindtrip/06 §4.2）：同屏 >40 个时按 30px 网格聚合，否则 12px。 */

export interface ScreenPoint {
  x: number
  y: number
}

export interface ClusterGroup {
  key: string
  items: CandidatePlace[]
  x: number
  y: number
}

export function clusterGrid(count: number): number {
  return count > 40 ? 30 : 12
}

export function clusterCandidates(
  items: CandidatePlace[],
  locate: (item: CandidatePlace) => ScreenPoint | null,
  grid = clusterGrid(items.length),
): ClusterGroup[] {
  const cells = new Map<string, ClusterGroup>()
  for (const item of items) {
    const point = locate(item)
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    const key = `${Math.round(point.x / grid)}:${Math.round(point.y / grid)}`
    const existing = cells.get(key)
    if (existing) {
      existing.items.push(item)
      existing.x += point.x
      existing.y += point.y
    } else {
      cells.set(key, { key, items: [item], x: point.x, y: point.y })
    }
  }
  return [...cells.values()].map(group => ({
    ...group,
    x: group.x / group.items.length,
    y: group.y / group.items.length,
  }))
}

export function firstLocated(group: ClusterGroup): CandidatePlace | null {
  return group.items.find(item => item.lat != null && item.lng != null) || null
}
