/* Real 高德 JS API 2.0 adapter, used when VITE/backend config provides
   AMAP_JS_KEY.  Falls back to the SVG MapCanvas if the SDK cannot load.
   The adapter exposes the same MapController contract as MapCanvas, so the
   workbench (selection, day filter, diff highlighting) is transport-agnostic. */

import AMapLoader from '@amap/amap-jsapi-loader'
import type { CandidatePlace, DiffEntry, FlightDetail, MapLayers, RouteLeg, SavedPlace, Stop, Trip } from '../types'
import type { MapController } from './controller'
import { shortName } from '../lib/format'
import { placeIcon } from '../lib/placeMeta'
import { clusterCandidates, firstLocated } from './layers/candidates'
import { legLabel } from './layers/routeLabel'

interface AmapOptions {
  key: string
  securityCode?: string
  onMarkerClick?: (stopId: string) => void
  onBlankClick?: () => void
  onCandidateClick?: (poiId: string) => void
  onCandidateAdd?: (poiId: string) => void
}

const DAY_COLORS: Record<number, string> = {
  1: 'hsl(152,55%,33%)',
  2: 'hsl(200,62%,42%)',
  3: 'hsl(262,52%,50%)',
  4: 'hsl(326,55%,46%)',
  5: 'hsl(14,68%,48%)',
  6: 'hsl(40,78%,42%)',
  7: 'hsl(76,52%,36%)',
  8: 'hsl(110,45%,36%)',
  9: 'hsl(172,52%,34%)',
  10: 'hsl(216,58%,46%)',
  11: 'hsl(284,46%,48%)',
  12: 'hsl(344,58%,46%)',
}

interface MapStop extends Stop {
  dayIndex: number
}

export class AmapCanvas implements MapController {
  container: HTMLElement
  map: any = null
  AMap: any = null
  readonly ready: Promise<void>
  private options: AmapOptions
  private stops: MapStop[] = []
  private markers = new Map<string, any>()
  private overlaysByDay = new Map<number, any[]>()
  private waypoints: any[] = []
  private selectedDay: number | 'all' = 'all'
  private selectedStop: string | null = null
  private diffTags = new Map<string, string>()
  private rightInset = 0
  private bottomInset = 0
  private pendingTrip: Trip | null = null
  private destroyed = false
  private candidates: CandidatePlace[] = []
  private savedList: SavedPlace[] = []
  private routePolyline = new Map<string, [number, number][]>()
  private routeLegsById = new Map<string, RouteLeg>()
  private candidateMarkers: any[] = []
  private savedMarkers: any[] = []
  private highlightIds: Set<string> = new Set()
  private layers: MapLayers = { trip: true, nearby: true, saved: false }
  private themeObserver: MutationObserver | null = null

  constructor(container: HTMLElement, options: AmapOptions) {
    this.container = container
    this.options = options
    container.classList.add('map-canvas', 'map-canvas-amap')
    this.ready = this._init()
  }

  private async _init() {
    if (this.options.securityCode) {
      ;(window as any)._AMapSecurityConfig = { securityJsCode: this.options.securityCode }
    }
    const AMap = await AMapLoader.load({
      key: this.options.key,
      version: '2.0',
      plugins: ['AMap.Scale'],
    })
    if (this.destroyed) return
    this.AMap = AMap
    this.map = new AMap.Map(this.container, {
      zoom: 5,
      center: [86.5, 44.5],
      viewMode: '2D',
      mapStyle: document.documentElement.dataset.theme === 'dark' ? 'amap://styles/dark' : 'amap://styles/normal',
      showLabel: true,
    })
    this.map.on('click', () => this.options.onBlankClick?.())
    this.map.on('zoomend', () => {
      this._renderCandidates()
      this._applyRouteLabelVisibility()
    })
    this.map.addControl(new AMap.Scale())
    this.themeObserver = new MutationObserver(() => {
      this.map?.setMapStyle?.(
        document.documentElement.dataset.theme === 'dark' ? 'amap://styles/dark' : 'amap://styles/normal',
      )
    })
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    if (this.pendingTrip) {
      const trip = this.pendingTrip
      this.pendingTrip = null
      this.setTrip(trip)
    }
  }

  setTrip(trip: Trip) {
    if (!this.map) {
      this.pendingTrip = trip
      return
    }
    this._clearAll()
    this.stops = []
    for (const day of trip.days) {
      for (const stop of day.stops) this.stops.push({ ...stop, dayIndex: day.dayIndex })
    }
    for (const day of trip.days) this._renderDay(day.dayIndex)
    this._renderWaypoints(trip)
    this.applyDayFilter('all')
    this._applyRouteLabelVisibility()
    this._applyHighlight()
    this._renderCandidates()
    this._renderSaved()
    this.fitView('all')
  }

  syncTrip(trip: Trip, changedDays: number[] = [], diff: DiffEntry[] = []) {
    if (!this.map) {
      this.pendingTrip = trip
      return
    }
    const next = new Map<string, MapStop>()
    for (const day of trip.days) for (const stop of day.stops) next.set(stop.stopId, { ...stop, dayIndex: day.dayIndex })
    for (const [id, marker] of this.markers) {
      if (!next.has(id)) {
        this.map.remove(marker)
        this.markers.delete(id)
      }
    }
    const days = new Set(changedDays)
    this.stops = [...next.values()]
    for (const id of changedDays) this._rebuildDay(id)
    for (const entry of diff) {
      if (entry.activityId) {
        const found = this.stops.find(s => s.activities.some(a => a.activityId === entry.activityId))
        if (found && entry.label) this.addDiffTag(found.stopId, entry.label)
        if (found) this.pulseMarker(found.stopId)
      }
      if (entry.stopId) {
        this.pulseMarker(entry.stopId)
        if (entry.label) this.addDiffTag(entry.stopId, entry.label)
      }
    }
    this._renderWaypoints(trip)
    this._applyHighlight()
    this._renderCandidates()
    this._renderSaved()
    if (this.selectedDay !== 'all') this.applyDayFilter(this.selectedDay)
  }

  private _clearAll() {
    this.map.clearMap()
    this.markers.clear()
    this.overlaysByDay.clear()
    this.waypoints = []
  }

  private _rebuildDay(dayIndex: number) {
    for (const overlay of this.overlaysByDay.get(dayIndex) || []) this.map.remove(overlay)
    this.overlaysByDay.set(dayIndex, [])
    this._renderDay(dayIndex)
  }

  private _renderDay(dayIndex: number) {
    const stops = this.stops.filter(s => s.dayIndex === dayIndex).sort((a, b) => a.seq - b.seq)
    for (const stop of stops) this._marker(stop)
    this._renderDayRoutes(dayIndex)
  }

  private _renderDayRoutes(dayIndex: number) {
    const stops = this.stops.filter(s => s.dayIndex === dayIndex).sort((a, b) => a.seq - b.seq)
    const overlays: any[] = []
    for (let i = 1; i < stops.length; i++) overlays.push(...this._routeBetween(stops[i - 1], stops[i], dayIndex))
    for (const stop of stops) {
      for (const act of stop.activities) {
        if (act.type === 'long_transit' && act.transitDetail?.mode === 'flight') {
          overlays.push(...this._flightArc(act.transitDetail as FlightDetail, dayIndex))
        }
      }
    }
    for (const overlay of overlays) this.map.add(overlay)
    this.overlaysByDay.set(dayIndex, overlays)
  }

  /**
   * 路线层按天重建，而不是靠 show/hide：
   * 高德 Text 的 hide 在部分版本上对自定义 content 不生效，会漏出别天的标签。
   */
  private _rerenderRouteLayers(day: number | 'all') {
    if (!this.map) return
    for (const overlays of this.overlaysByDay.values()) {
      for (const overlay of overlays) this.map.remove(overlay)
    }
    this.overlaysByDay.clear()
    const days = day === 'all' ? [...new Set(this.stops.map(stop => stop.dayIndex))] : [day]
    for (const dayIndex of days) this._renderDayRoutes(dayIndex)
    this._applyRouteLabelVisibility()
  }

  private _marker(stop: MapStop) {
    if (!stop.poi.lng || !stop.poi.lat) return
    const existing = this.markers.get(stop.stopId)
    if (existing) this.map.remove(existing)
    const color = DAY_COLORS[((stop.dayIndex - 1) % 12) + 1]
    const content = document.createElement('div')
    content.className = 'amap-pin-wrap'
    content.innerHTML = `
      <div class="amap-pin" style="--day-color:${color}">
        <span class="amap-num">${stop.seq}</span>
        <span class="amap-name">${escapeHtml(shortName(stop.poi.name))}</span>
        <span class="amap-diff" style="display:none"></span>
      </div>`
    content.addEventListener('click', e => {
      e.stopPropagation()
      this.selectStop(stop.stopId, true)
    })
    const marker = new this.AMap.Marker({
      position: [stop.poi.lng, stop.poi.lat],
      content,
      anchor: 'center',
      offset: new this.AMap.Pixel(0, 0),
      zIndex: 100 + stop.seq,
    })
    this.map.add(marker)
    this.markers.set(stop.stopId, marker)
    if (this.diffTags.has(stop.stopId)) this._paintDiff(stop.stopId)
  }

  private _paintDiff(stopId: string) {
    const marker = this.markers.get(stopId)
    if (!marker) return
    const node = marker.getContent?.() as HTMLElement | string
    if (typeof node === 'string') return
    const tag = node.querySelector('.amap-diff') as HTMLElement | null
    const text = this.diffTags.get(stopId)
    if (tag && text) {
      tag.style.display = 'block'
      tag.textContent = text
    }
  }

  private _routeBetween(a: MapStop, b: MapStop, dayIndex: number): any[] {
    if (!a.poi.lng || !a.poi.lat || !b.poi.lng || !b.poi.lat) return []
    const first = b.activities[0]
    let mode = 'city'
    let meta: any = null
    if (first?.type === 'long_transit' && first.transitDetail) {
      mode = first.transitDetail.mode
      meta = first.transitDetail
    } else if (first?.transitFromPrev) {
      mode = first.transitFromPrev.mode === 'drive' && (first.transitFromPrev.distanceKm || 0) > 60 ? 'self_drive' : 'city'
      meta = first.transitFromPrev
    }
    if (!meta) {
      // Long transit is stored on the origin stop in some plans (flight/self-drive
      // to the next stop). Use its geometry for the origin -> next leg.
      const prevLong = [...a.activities]
        .reverse()
        .find(act => act.type === 'long_transit' && act.transitDetail)
      if (prevLong?.transitDetail) {
        mode = prevLong.transitDetail.mode
        meta = prevLong.transitDetail
      }
    }
    const lineStyle: Record<string, { color: string; dash: number[] | null }> = {
      city: { color: '#64748B', dash: null },
      flight: { color: '#6366F1', dash: [10, 8] },
      train: { color: '#C2410C', dash: [8, 7] },
      self_drive: { color: '#1D6F5C', dash: [12, 5, 2, 5] },
    }
    const style = lineStyle[mode] || lineStyle.city
    // 真实道路几何：沿道路画实线 + 白色描边（不再两点一线/虚线）
    const geometry = this.routePolyline.get(`${a.stopId}__${b.stopId}`)
    if (geometry && mode !== 'flight' && mode !== 'train') {
      const roadMode = meta?.mode === 'walk' ? 'walk' : meta?.mode === 'transit' ? 'transit' : 'drive'
      const roadColor = roadMode === 'drive' ? '#1D6F5C' : '#2563EB'
      const roadDash = roadMode === 'walk' ? [4, 6] : roadMode === 'transit' ? [10, 6] : null
      const legData = this.routeLegsById.get(`${a.stopId}__${b.stopId}`)
      const overlays: any[] = []
      const casing = new this.AMap.Polyline({
        path: geometry,
        strokeColor: '#FFFFFF',
        strokeWeight: 9,
        strokeOpacity: 0.92,
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: 18,
        bubble: true,
      })
      ;(casing as any).__tpFrom = a.stopId
      ;(casing as any).__tpTo = b.stopId
      ;(casing as any).__tpGeometry = true
      ;(casing as any).__tpCasing = true
      overlays.push(casing)
      const polyline = new this.AMap.Polyline({
        path: geometry,
        strokeColor: roadColor,
        strokeWeight: 5,
        strokeOpacity: 0.96,
        strokeStyle: roadDash ? 'dashed' : 'solid',
        strokeDasharray: roadDash || undefined,
        lineJoin: 'round',
        lineCap: 'round',
        showDir: true,
        dirColor: roadColor,
        zIndex: 20,
      })
      ;(polyline as any).__tpFrom = a.stopId
      ;(polyline as any).__tpTo = b.stopId
      ;(polyline as any).__tpMode = mode
      ;(polyline as any).__tpGeometry = true
      overlays.push(polyline)
      const middle = geometry[Math.floor(geometry.length * 0.82)] || [b.poi.lng, b.poi.lat]
      const label = legLabel(legData) || (mode === 'city' && (meta?.minutes || meta?.driveMinutes)
        ? `${meta.mode === 'walk' ? '🚶' : meta.mode === 'transit' ? '🚌' : '🚗'}${meta.minutes || Math.round(meta.driveMinutes)}分钟`
        : mode === 'self_drive' && meta?.distanceKm
          ? `🚗${Math.round(((meta.driveMinutes || meta.minutes || 0) / 60) * 10) / 10}h · ${meta.distanceKm}km`
          : null)
      if (label) {
        overlays.push(this._routeLabelMarker([middle[0], middle[1]], label))
      }
      return overlays
    }
    if (mode === 'flight') {
      const mid = [
        (a.poi.lng + b.poi.lng) / 2,
        (a.poi.lat + b.poi.lat) / 2 + Math.min(2.5, Math.abs(b.poi.lng - a.poi.lng) * 0.18 + 0.4),
      ]
      const curve = this.AMap.BezierCurve
        ? new this.AMap.BezierCurve({
            path: [[a.poi.lng, a.poi.lat], mid, [b.poi.lng, b.poi.lat]],
            strokeColor: style.color,
            strokeWeight: 2.5,
            strokeStyle: 'dashed',
            strokeDasharray: style.dash,
            lineJoin: 'round',
            showDir: true,
            dirColor: style.color,
            zIndex: 20,
          })
        : null
      if (curve) return [curve]
    }
    const polyline = new this.AMap.Polyline({
      path: [[a.poi.lng, a.poi.lat], [b.poi.lng, b.poi.lat]],
      strokeColor: style.color,
      strokeWeight: mode === 'city' ? 2 : 2.5,
      strokeStyle: style.dash ? 'dashed' : 'solid',
      strokeDasharray: style.dash,
      lineJoin: 'round',
      showDir: true,
      dirColor: style.color,
      zIndex: 20,
    })
    ;(polyline as any).__tpFrom = a.stopId
    ;(polyline as any).__tpTo = b.stopId
    ;(polyline as any).__tpMode = mode
    ;(polyline as any).__tpStyle = style
    const overlays: any[] = [polyline]
    const arrow = this._routeArrow(a, b, style.color)
    if (arrow) {
      ;(arrow as any).__tpArrow = true
      overlays.push(arrow)
    }
    const legData = this.routeLegsById.get(`${a.stopId}__${b.stopId}`)
    const label = mode === 'train'
      ? `🚆 ${meta?.trainNo || ''}`
      : mode === 'flight'
        ? `✈ ${meta?.flightNo || ''}`
        : legLabel(legData) || (mode === 'city' && (meta?.minutes || meta?.driveMinutes)
          ? `${meta.mode === 'walk' ? '🚶' : meta.mode === 'transit' ? '🚌' : '🚗'}${meta.minutes || Math.round(meta.driveMinutes)}分钟`
          : mode === 'self_drive' && meta?.distanceKm
            ? `🚗${Math.round(((meta.driveMinutes || meta.minutes || 0) / 60) * 10) / 10}h · ${meta.distanceKm}km`
            : null)
    if (label) {
      overlays.push(this._routeLabelMarker([a.poi.lng + (b.poi.lng - a.poi.lng) * 0.8, a.poi.lat + (b.poi.lat - a.poi.lat) * 0.8], label))
    }
    return overlays
  }

  private _routeArrow(a: MapStop, b: MapStop, color: string): any {
    if (!this.AMap || a.poi.lng == null || a.poi.lat == null || b.poi.lng == null || b.poi.lat == null) {
      return null
    }
    const lng = a.poi.lng + (b.poi.lng - a.poi.lng) * 0.55
    const lat = a.poi.lat + (b.poi.lat - a.poi.lat) * 0.55
    const dx = (b.poi.lng - a.poi.lng) * Math.cos(((a.poi.lat + b.poi.lat) / 2) * Math.PI / 180)
    const dy = b.poi.lat - a.poi.lat
    const angle = (Math.atan2(dx, dy) * 180) / Math.PI
    const el = document.createElement('div')
    el.className = 'amap-route-arrow'
    el.style.setProperty('--arrow-color', color)
    el.style.transform = `rotate(${angle}deg)`
    return new this.AMap.Marker({
      position: [lng, lat],
      content: el,
      anchor: 'center',
      zIndex: 25,
    })
  }

  /** 低缩放时隐藏路线文字，避免全图标注挤成一片（§4.2 图例从简）。 */
  private _applyRouteLabelVisibility() {
    if (!this.map) return
    const show = (this.map.getZoom?.() ?? 0) >= 7
    for (const overlays of this.overlaysByDay.values()) {
      for (const overlay of overlays) {
        if (!overlay.__tpRouteLabel) continue
        if (typeof overlay.show === 'function' && typeof overlay.hide === 'function') {
          show ? overlay.show() : overlay.hide()
        }
      }
    }
  }

  private _flightArc(td: FlightDetail, dayIndex: number): any[] {
    const known: Record<string, [number, number]> = {
      '乌鲁木齐地窝堡 T3': [87.47, 43.91],
      '乌鲁木齐地窝堡 T2': [87.47, 43.91],
      伊宁机场: [81.33, 43.96],
      '上海虹桥 T2': [121.34, 31.19],
    }
    const from = td.airportFrom ? known[td.airportFrom] : undefined
    const to = td.airportTo ? known[td.airportTo] : undefined
    if (!from || !to) return []
    const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 + 2.2]
    const curve = this.AMap.BezierCurve
      ? new this.AMap.BezierCurve({
          path: [from, mid, to],
          strokeColor: '#6366F1',
          strokeWeight: 2.5,
          strokeStyle: 'dashed',
          strokeDasharray: [10, 8],
          zIndex: 18,
          showDir: true,
        })
      : new this.AMap.Polyline({
          path: [from, to],
          strokeColor: '#6366F1',
          strokeWeight: 2.5,
          strokeStyle: 'dashed',
          zIndex: 18,
        })
    return [curve]
  }

  private _renderWaypoints(trip: Trip) {
    for (const w of this.waypoints) this.map.remove(w)
    this.waypoints = []
    for (const day of trip.days) {
      for (const stop of day.stops) {
        for (const act of stop.activities) {
          const td = act.transitDetail
          if (!td || td.mode !== 'self_drive') continue
          for (const wp of td.waypointsPoi || []) {
            if (wp.lng == null || wp.lat == null) continue
            const circle = new this.AMap.CircleMarker({
              center: [wp.lng, wp.lat],
              radius: 4,
              strokeColor: '#1D6F5C',
              strokeWeight: 2,
              fillColor: '#FFFFFF',
              fillOpacity: 1,
              zIndex: 15,
              bubble: true,
            })
            ;(circle as any).__tpDay = day.dayIndex
            this.map.add(circle)
            this.waypoints.push(circle)
          }
        }
      }
    }
  }

  applyDayFilter(day: number | 'all') {
    if (!this.map) return
    this.selectedDay = day
    this._applyDayVisibility()
    this._rerenderRouteLayers(day)
    if (day !== 'all') this.fitView(day)
  }

  /** 路线气泡用 Marker 而不是 AMap.Text：Text 的 show/hide 不可靠，排查过会漏出别天的标签。 */
  private _routeLabelMarker(position: [number, number], text: string): any {
    const el = document.createElement('div')
    el.className = 'tp-amap-route-label'
    el.textContent = text
    const marker = new this.AMap.Marker({
      position,
      content: el,
      anchor: 'center',
      zIndex: 30,
      bubble: true,
    })
    ;(marker as any).__tpRouteLabel = true
    ;(marker as any).__tpText = true
    return marker
  }

  /** 高德覆盖物（Polyline/Text/Marker）的 show/hide 兼容处理。 */
  private _setVisible(overlay: any, visible: boolean) {
    if (!overlay) return
    if (typeof overlay.show === 'function' && typeof overlay.hide === 'function') {
      visible ? overlay.show() : overlay.hide()
      return
    }
    if (typeof overlay.setVisible === 'function') {
      overlay.setVisible(visible)
      return
    }
    const dom = overlay.dom || overlay.getDOM?.() || overlay.getContent?.()
    if (dom && dom.style) dom.style.display = visible ? '' : 'none'
  }

  /** 仅切换可见性（几何到达重绘后调用，避免重新 fit 抢视野）。 */
  private _applyDayVisibility() {
    if (!this.map) return
    const day = this.selectedDay
    const all = day === 'all'

    // 严格过滤：选中某天时，其他天的 marker / 路线 / 途经点直接隐藏。
    // 不做「降低透明度」——用户要的是专注当天，而不是在一张图上辨认哪条是当天的。
    for (const stop of this.stops) {
      const marker = this.markers.get(stop.stopId)
      if (!marker) continue
      const on = all || stop.dayIndex === day
      this._setVisible(marker, on)
      this._setMarkerOpacity(marker, on ? 1 : 0)
    }
    for (const wp of this.waypoints) {
      const on = all || (wp as any).__tpDay === day
      this._setVisible(wp, on)
      if (typeof wp.setOptions === 'function') {
        wp.setOptions({ strokeOpacity: on ? 1 : 0, fillOpacity: on ? 1 : 0 })
      }
    }
    this._applyRouteLabelVisibility()
  }

  /** 真实道路几何到达后重绘路线（不 fit，不改变当前视野）。 */
  setRouteLegs(legs: RouteLeg[]) {
    if (!this.map) {
      this.routePolyline.clear()
      for (const leg of legs || []) {
        if (Array.isArray(leg.polyline) && leg.polyline.length > 1) {
          this.routePolyline.set(`${leg.fromStopId}__${leg.toStopId}`, leg.polyline as [number, number][])
        }
      }
      return
    }
    this.routePolyline.clear()
    this.routeLegsById.clear()
    for (const leg of legs || []) {
      this.routeLegsById.set(`${leg.fromStopId}__${leg.toStopId}`, leg)
      if (Array.isArray(leg.polyline) && leg.polyline.length > 1) {
        this.routePolyline.set(`${leg.fromStopId}__${leg.toStopId}`, leg.polyline as [number, number][])
      }
    }
    this._rerenderRouteLayers(this.selectedDay)
    this._applyHighlight()
    this._renderCandidates()
    this._renderSaved()
  }

  private _setMarkerOpacity(marker: any, opacity: number) {
    if (typeof marker.setOpacity === 'function') {
      marker.setOpacity(opacity)
      return
    }
    if (typeof marker.setOptions === 'function') {
      marker.setOptions({ opacity })
      return
    }
    const el = marker.getElement?.() || marker.dom
    if (el?.style) el.style.opacity = String(opacity)
  }

  // ------------------------------------------------------------------
  // 候选层 / 收藏层 / 高亮层（mindtrip/06 §3、§4、§11）
  // ------------------------------------------------------------------
  private _renderCandidates() {
    if (!this.map || !this.AMap) return
    for (const marker of this.candidateMarkers) this.map.remove(marker)
    this.candidateMarkers = []
    if (!this.layers.nearby || !this.candidates.length) return
    const groups = clusterCandidates(this.candidates, item => {
      if (item.lat == null || item.lng == null) return null
      const point = this.map.lngLatToContainer([item.lng, item.lat])
      return { x: point.x, y: point.y }
    })
    for (const group of groups) {
      const sample = firstLocated(group)
      if (!sample || sample.lat == null || sample.lng == null) continue
      const hit = this.highlightIds.size > 0 && group.items.some(item => this.highlightIds.has(item.poiId))
      const dim = this.highlightIds.size > 0 && !hit
      const node = document.createElement('div')
      node.className = `amap-cand-wrap${dim ? ' dimmed' : ''}${hit ? ' highlight-hit' : ''}`
      if (group.items.length > 1) {
        node.innerHTML = `<div class="cand-cluster">${group.items.length}</div>`
        node.addEventListener('click', e => {
          e.stopPropagation()
          this.map.setZoom(Math.min(18, this.map.getZoom() + 2))
        })
      } else {
        const item = group.items[0]
        node.innerHTML = `<div class="cand-marker"><span class="cand-glyph">${placeIcon(item.category)}</span>${item.added ? '<span class="cand-added-dot"></span>' : '<span class="cand-plus" role="button" aria-label="加入行程">+</span>'}</div>`
        node.querySelector('.cand-plus')?.addEventListener('click', e => {
          e.stopPropagation()
          this.options.onCandidateAdd?.(item.poiId)
        })
        node.addEventListener('click', e => {
          e.stopPropagation()
          this.options.onCandidateClick?.(item.poiId)
        })
      }
      const marker = new this.AMap.Marker({
        position: [sample.lng, sample.lat],
        content: node,
        anchor: 'center',
        zIndex: 140,
      })
      this.map.add(marker)
      this.candidateMarkers.push(marker)
    }
  }

  private _renderSaved() {
    if (!this.map || !this.AMap) return
    for (const marker of this.savedMarkers) this.map.remove(marker)
    this.savedMarkers = []
    if (!this.layers.saved) return
    for (const item of this.savedList) {
      if (item.lat == null || item.lng == null) continue
      const node = document.createElement('div')
      node.className = 'amap-saved-wrap'
      node.innerHTML = '<div class="saved-marker"><span class="saved-glyph">♡</span></div>'
      node.addEventListener('click', e => {
        e.stopPropagation()
        this.options.onCandidateClick?.(item.poiId)
      })
      const marker = new this.AMap.Marker({
        position: [item.lng, item.lat],
        content: node,
        anchor: 'center',
        zIndex: 80,
      })
      this.map.add(marker)
      this.savedMarkers.push(marker)
    }
  }

  private _applyHighlight() {
    const active = this.highlightIds.size > 0
    for (const stop of this.stops) {
      const marker = this.markers.get(stop.stopId)
      if (!marker) continue
      const node = marker.getContent?.() as HTMLElement | string
      if (typeof node === 'string') continue
      const pin = node.querySelector('.amap-pin') || node
      const hit = active && this.highlightIds.has(stop.stopId)
      pin.classList.toggle('dimmed', active && !hit)
      pin.classList.toggle('highlight-hit', hit)
    }
  }

  setHighlight(poiIds: string[]) {
    this.highlightIds = new Set(poiIds.filter(Boolean))
    this._applyHighlight()
    this._renderCandidates()
  }

  setCandidates(list: CandidatePlace[]) {
    this.candidates = (list || []).filter(item => item.lat != null && item.lng != null)
    this._renderCandidates()
  }

  clearCandidates() {
    this.candidates = []
    for (const marker of this.candidateMarkers) this.map?.remove(marker)
    this.candidateMarkers = []
  }

  setSaved(list: SavedPlace[]) {
    this.savedList = list || []
    this._renderSaved()
  }

  setLayerVisibility(layers: MapLayers) {
    this.layers = { ...layers }
    for (const stop of this.stops) {
      const marker = this.markers.get(stop.stopId)
      if (!marker) continue
      const visible =
        layers.trip && (this.selectedDay === 'all' || this.selectedDay === stop.dayIndex)
      if (typeof marker.show === 'function') visible ? marker.show() : marker.hide()
      this._setMarkerOpacity(marker, visible ? 1 : 0)
    }
    for (const [dayIndex, overlays] of this.overlaysByDay) {
      const visible = layers.trip && (this.selectedDay === 'all' || this.selectedDay === dayIndex)
      for (const overlay of overlays) {
        if (typeof overlay.show === 'function') visible ? overlay.show() : overlay.hide()
        if (overlay.setOptions) overlay.setOptions({ strokeOpacity: visible ? 1 : 0 })
      }
    }
    this._renderCandidates()
    this._renderSaved()
  }

  highlightLeg(fromStopId: string, toStopId: string) {
    for (const overlays of this.overlaysByDay.values()) {
      for (const overlay of overlays) {
        if (!overlay.setOptions) continue
        const hit = overlay.__tpFrom === fromStopId && overlay.__tpTo === toStopId
        if (overlay.__tpGeometry) {
          overlay.setOptions({
            strokeWeight: overlay.__tpCasing ? 8 : hit ? 5 : 4,
            strokeOpacity: hit ? 1 : overlay.__tpCasing ? 0.12 : 0.18,
          })
          continue
        }
        if (!overlay.__tpFrom) continue
        overlay.setOptions({ strokeWeight: hit ? 4.5 : 2, strokeOpacity: hit ? 1 : 0.16 })
      }
    }
  }

  clearLegHighlight() {
    for (const overlays of this.overlaysByDay.values()) {
      for (const overlay of overlays) {
        if (!overlay.setOptions) continue
        if (overlay.__tpGeometry) {
          overlay.setOptions({
            strokeWeight: overlay.__tpCasing ? 8 : 4,
            strokeOpacity: overlay.__tpCasing ? 0.9 : 0.95,
          })
          continue
        }
        if (!overlay.__tpFrom) continue
        const mode = overlay.__tpMode || 'city'
        overlay.setOptions({ strokeWeight: mode === 'city' ? 2 : 2.5, strokeOpacity: 1 })
      }
    }
  }

  private _locatePlace(poiId: string): { lat: number; lng: number } | null {
    const stop = this.stops.find(
      s => s.stopId === poiId || (s.poi.amapPoiId != null && s.poi.amapPoiId === poiId),
    )
    if (stop?.poi.lat != null && stop.poi.lng != null) return { lat: stop.poi.lat, lng: stop.poi.lng }
    const candidate = this.candidates.find(item => item.poiId === poiId)
    if (candidate?.lat != null && candidate.lng != null) return { lat: candidate.lat, lng: candidate.lng }
    const saved = this.savedList.find(item => item.poiId === poiId)
    if (saved?.lat != null && saved.lng != null) return { lat: saved.lat, lng: saved.lng }
    return null
  }

  viewCenter() {
    const center = this.map?.getCenter?.()
    if (!center) return null
    return { lng: center.getLng(), lat: center.getLat() }
  }

  focusPlace(poiId: string, opts: { zoom?: number } = {}) {
    if (!this.map) return
    const place = this._locatePlace(poiId)
    if (!place) return
    this.map.setZoomAndCenter(Math.max(14, Math.min(17, opts.zoom ?? 14)), [place.lng, place.lat])
  }

  fitView(day: number | 'all' | null) {
    if (!this.map) return
    const pts = this.stops
      .filter(s => (day === 'all' || day == null ? true : s.dayIndex === day))
      .filter(s => s.poi.lng && s.poi.lat)
    if (!pts.length) return
    const lngs = pts.map(s => s.poi.lng as number)
    const lats = pts.map(s => s.poi.lat as number)
    const bounds = new this.AMap.Bounds(
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    )
    const size = this.map.getSize?.()
    const width = size?.width || this.container.clientWidth || 800
    const height = size?.height || this.container.clientHeight || 600
    const pad = Math.max(40, Math.min(72, Math.min(width, height) / 8))
    // 顶部工具栏（图层/参数条/高亮胶囊）会盖住 marker，fit 时给它留出空间
    const avoid = [150, pad, Math.max(96, Math.round(this.bottomInset * 0.5)), pad]
    // AMap 2.0 的 setBounds 在 marker 刚 add 完的同一帧里偶发不生效；
    // setFitView 以可见覆盖物为准，且 immediately=true 不依赖动画帧。
    if (typeof this.map.setFitView === 'function') {
      // 只按 stop marker 取景：路线 overlay 里有跨省航班弧，setFitView(null)
      // 会把视野拉到全国；航线只作为上下文，不应决定初始视图。
      const visibleOverlays: any[] = []
      for (const stop of this.stops) {
        if (day !== 'all' && day != null && stop.dayIndex !== day) continue
        const marker = this.markers.get(stop.stopId)
        if (marker) visibleOverlays.push(marker)
      }
      if (visibleOverlays.length) {
        this.map.setFitView(visibleOverlays, true, avoid)
      } else {
        this.map.setBounds(bounds, true, avoid)
      }
    } else {
      this.map.setBounds(bounds, true, avoid)
    }
    // 底部抽屉盖住下半屏：把地图内容整体上移半个抽屉高度，
    // 让 marker 落在可视区域上方，而不是藏在卡片后面。
    const lift = Math.round(Math.min(this.bottomInset * 1.15, this.container.clientHeight * 0.68))
    const shift = Math.round(this.rightInset * 0.55)
    if ((lift > 0 || shift > 0) && typeof this.map.panBy === 'function') {
      this.map.panBy(-shift, -lift, true)
    }
    this._applyRouteLabelVisibility()
    // 若地图因容器隐藏等原因没尺寸，setFitView 仍然会失败；此时用一次中心兜底。
    const center = this.map.getCenter?.()
    if (!center || Math.abs(center.getLng() - (Math.min(...lngs) + Math.max(...lngs)) / 2) > 30) {
      this.map.setZoomAndCenter(6, [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2])
    }
  }

  zoomBy(factor: number) {
    if (!this.map) return
    const z = this.map.getZoom()
    this.map.setZoom(Math.min(18, Math.max(3, z + (factor > 1 ? 1 : -1))))
  }

  screenPos(stopId: string) {
    if (!this.map) return null
    const stop = this.stops.find(s => s.stopId === stopId)
    if (!stop?.poi.lng || !stop.poi.lat) return null
    const pos = this.map.lngLatToContainer([stop.poi.lng, stop.poi.lat])
    return { x: pos.x, y: pos.y }
  }

  centerOn(stopId: string) {
    if (!this.map) return
    const stop = this.stops.find(s => s.stopId === stopId)
    if (!stop?.poi.lng || !stop.poi.lat) return
    this.map.setZoomAndCenter(Math.max(8, this.map.getZoom()), [stop.poi.lng, stop.poi.lat])
  }

  selectStop(stopId: string | null, fromMap = false) {
    this.selectedStop = stopId
    for (const [id, marker] of this.markers) {
      const node = marker.getContent?.() as HTMLElement | string
      if (typeof node !== 'string') node.classList.toggle('selected', id === stopId)
    }
    if (fromMap && stopId) this.options.onMarkerClick?.(stopId)
  }

  clearSelection() {
    this.selectStop(null)
  }

  pulseMarker(stopId: string) {
    const marker = this.markers.get(stopId)
    if (!marker) return
    const node = marker.getContent?.() as HTMLElement | string
    if (typeof node === 'string') return
    const pin = node.querySelector('.amap-pin')
    if (!pin) return
    pin.classList.remove('pulse')
    void (pin as HTMLElement).offsetWidth
    pin.classList.add('pulse')
    window.setTimeout(() => pin.classList.remove('pulse'), 1300)
  }

  addDiffTag(stopId: string, text: string) {
    this.diffTags.set(stopId, text)
    this._paintDiff(stopId)
  }

  setRightInset(px: number) {
    this.rightInset = Math.max(0, px)
  }

  setBottomInset(px: number) {
    this.bottomInset = Math.max(0, px)
  }

  destroy() {
    this.destroyed = true
    this.themeObserver?.disconnect()
    this.themeObserver = null
    this.candidateMarkers = []
    this.savedMarkers = []
    this.map?.destroy?.()
    this.map = null
    this.container.innerHTML = ''
  }
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
