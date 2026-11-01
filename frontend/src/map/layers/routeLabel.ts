import type { RouteLeg } from '../../types'

const MODE_ICON: Record<string, string> = {
  walk: '🚶',
  bike: '🚲',
  transit: '🚌',
  train: '🚆',
  flight: '✈',
  ferry: '⛴',
  drive: '🚗',
}

/** 路线气泡文案：优先用真实 route_legs（高德距离/时长），没有才退到行程里的估算。 */
export function legLabel(leg?: RouteLeg | null): string | null {
  if (!leg) return null
  if (leg.mode === 'flight' || leg.mode === 'train') return null
  // 不用行程里的旧估算冒充高德：道路段必须是高德规划过的数据
  if (leg.source !== 'amap') return null
  const icon = MODE_ICON[leg.mode] || '🚗'
  const parts: string[] = []
  if (leg.distanceM != null) {
    parts.push(leg.distanceM >= 1000 ? `${(leg.distanceM / 1000).toFixed(leg.distanceM >= 100000 ? 0 : 1)} km` : `${Math.round(leg.distanceM)} m`)
  }
  if (leg.durationMin != null) {
    const minutes = Math.round(leg.durationMin)
    parts.push(minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`)
  }
  return parts.length ? `${icon} ${parts.join(' · ')}` : null
}
