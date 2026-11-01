import type { CandidatePlace, DiffEntry, MapLayers, RouteLeg, SavedPlace, Trip } from '../types'

/**
 * 地图适配器契约（mindtrip/06 §3.4、§4.5）。
 *
 * P0 新增四个方法，三个适配器（SVG / Leaflet / 高德）都要实现：
 * - setHighlight(poiIds)：本轮高亮集合；空数组 = 清除
 * - focusPlace(poiId, opts)：chip / 候选点定位（zoom ≥14）
 * - setCandidates(list) / clearCandidates()：候选点图层（行程之外，不落库）
 * - setSaved(list)：收藏层（P1）
 *
 * `setLayerVisibility` 只切换图层的显隐，**不能**重建 marker；
 * `highlightLeg` 只降淡其它路线，不改 `setTrip` 的结果。
 */
export interface MapController {
  container: HTMLElement
  setTrip: (trip: Trip) => void
  syncTrip: (trip: Trip, changedDays?: number[], diff?: DiffEntry[]) => void
  applyDayFilter: (day: number | 'all') => void
  fitView: (day: number | 'all' | null) => void
  zoomBy: (factor: number) => void
  screenPos: (stopId: string) => { x: number; y: number } | null
  centerOn: (stopId: string) => void
  selectStop: (stopId: string | null, fromMap?: boolean) => void
  clearSelection: () => void
  pulseMarker: (stopId: string) => void
  addDiffTag: (stopId: string, text: string) => void
  setRightInset: (px: number) => void
  setBottomInset: (px: number) => void
  // ---- mindtrip/06 §3.4、§4.5 ----
  setHighlight: (poiIds: string[]) => void
  focusPlace: (poiId: string, opts?: { zoom?: number }) => void
  setCandidates: (list: CandidatePlace[]) => void
  clearCandidates: () => void
  setSaved: (list: SavedPlace[]) => void
  /** 真实道路几何（§5 / 04-replicate W2）：有 polyline 的 leg 沿道路绘制 */
  setRouteLegs: (legs: RouteLeg[]) => void
  setLayerVisibility: (layers: MapLayers) => void
  highlightLeg: (fromStopId: string, toStopId: string) => void
  clearLegHighlight: () => void
  /** 当前视野中心（「加地点」搜索附近用）；没有坐标时返回 null */
  viewCenter: () => { lng: number; lat: number } | null
  destroy: () => void
}
