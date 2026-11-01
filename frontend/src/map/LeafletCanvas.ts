/* Real map adapter: Leaflet + OpenStreetMap tiles.

This is the default map when no AMap JS key is configured.  It is a real
interactive geographic map (not a simulated canvas), and shares the same
MapController contract as the AMap and SVG adapters.
*/

import L from 'leaflet'
import type { CandidatePlace, DiffEntry, FlightDetail, MapLayers, RouteLeg, SavedPlace, Stop, Trip } from '../types'
import type { MapController } from './controller'
import { shortName, timeDiff } from '../lib/format'
import { placeIcon } from '../lib/placeMeta'
import { clusterCandidates, firstLocated } from './layers/candidates'
import { legLabel } from './layers/routeLabel'

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

const WAYPOINT_COORDS: Record<string, [number, number]> = {
  果子沟大桥: [81.62, 44.47],
  独库公路天瀑: [84.62, 43.72],
  恰库尔图: [89.13, 45.92],
  五彩湾: [88.42, 44.98],
}

interface MapStop extends Stop {
  dayIndex: number
}

interface Options {
  onMarkerClick?: (stopId: string) => void
  onBlankClick?: () => void
  onCandidateClick?: (poiId: string) => void
  onCandidateAdd?: (poiId: string) => void
}

export class LeafletCanvas implements MapController {
  container: HTMLElement
  map: L.Map
  private options: Options
  private stops: MapStop[] = []
  private markers = new Map<string, L.Marker>()
  private dayRoutes = new Map<number, L.Layer[]>()
  private waypoints: L.Layer[] = []
  private selectedDay: number | 'all' = 'all'
  private selectedStop: string | null = null
  private diffTags = new Map<string, string>()
  private rightInset = 0
  private bottomInset = 0
  private themeObserver: MutationObserver | null = null
  private resizeObserver: ResizeObserver | null = null
  private candidateLayer: L.LayerGroup
  private savedLayer: L.LayerGroup
  private candidates: CandidatePlace[] = []
  private savedList: SavedPlace[] = []
  private routePolyline = new Map<string, [number, number][]>()
  private routeLegsById = new Map<string, RouteLeg>()
  private highlightIds: Set<string> = new Set()
  private layers: MapLayers = { trip: true, nearby: true, saved: false }

  constructor(container: HTMLElement, options: Options = {}) {
    this.container = container
    this.options = options
    container.classList.add('map-canvas', 'map-canvas-leaflet')
    this.map = L.map(container, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: false,
      worldCopyJump: true,
    }).setView([43.8, 87.6], 5)
    L.control.attribution({ position: 'topleft', prefix: false }).addTo(this.map)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map)
    this.candidateLayer = L.layerGroup().addTo(this.map)
    this.savedLayer = L.layerGroup()
    this.map.on('click', () => this.options.onBlankClick?.())
    this.map.on('move zoom resize', () => {
      this.container.dispatchEvent(new CustomEvent('tp-map-transform'))
    })
    this.map.on('zoomend', () => {
      this._applyZoomClass()
      this._renderCandidates()
      this._applyRouteLabelVisibility()
    })
    this._applyZoomClass()
    this.themeObserver = new MutationObserver(() => this._applyTheme())
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    this.resizeObserver = new ResizeObserver(() => {
      this.map.invalidateSize({ pan: false })
    })
    this.resizeObserver.observe(container)
    this._applyTheme()
  }

  private _applyZoomClass() {
    this.container.classList.toggle('leaflet-low-zoom', this.map.getZoom() < 7)
  }

  private _applyTheme() {
    const dark = document.documentElement.dataset.theme === 'dark'
    this.container.classList.toggle('leaflet-dark', dark)
  }

  setTrip(trip: Trip) {
    this._clearAll()
    this.stops = []
    for (const day of trip.days) {
      for (const stop of day.stops) this.stops.push({ ...stop, dayIndex: day.dayIndex })
    }
    for (const stop of this.stops) this._renderMarker(stop)
    for (const dayIndex of new Set(this.stops.map(s => s.dayIndex))) this._renderDayRoutes(dayIndex)
    this._renderWaypoints(trip)
    this.applyDayFilter('all')
    this._applyRouteLabelVisibility()
    this._applyHighlight()
    this._renderCandidates()
    this._renderSaved()
    this.fitView('all')
  }

  private _clearAll() {
    for (const marker of this.markers.values()) this.map.removeLayer(marker)
    this.markers.clear()
    for (const layers of this.dayRoutes.values()) for (const layer of layers) this.map.removeLayer(layer)
    this.dayRoutes.clear()
    for (const layer of this.waypoints) this.map.removeLayer(layer)
    this.waypoints = []
  }

  private _markerHtml(stop: MapStop): string {
    const color = DAY_COLORS[((stop.dayIndex - 1) % 12) + 1]
    const diff = this.diffTags.get(stop.stopId)
    return `<div class="tp-leaflet-pin${this.selectedStop === stop.stopId ? ' selected' : ''}" style="--day-color:${color}">
      <span class="tp-pin-num">${stop.seq}</span>
      <span class="tp-pin-name">${escapeHtml(shortName(stop.poi.name))}</span>
      ${diff ? `<span class="tp-pin-diff">${escapeHtml(diff)}</span>` : ''}
    </div>`
  }

  private _renderMarker(stop: MapStop) {
    if (stop.poi.lng == null || stop.poi.lat == null) return
    const existing = this.markers.get(stop.stopId)
    if (existing) this.map.removeLayer(existing)
    const icon = L.divIcon({
      className: 'tp-leaflet-marker',
      html: this._markerHtml(stop),
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    })
    const marker = L.marker([stop.poi.lat, stop.poi.lng], { icon, riseOnHover: true })
    marker.on('click', e => {
      L.DomEvent.stopPropagation(e)
      this.selectStop(stop.stopId, true)
    })
    marker.addTo(this.map)
    this.markers.set(stop.stopId, marker)
  }

  private _refreshMarker(stop: MapStop) {
    const marker = this.markers.get(stop.stopId)
    if (!marker) {
      this._renderMarker(stop)
      return
    }
    if (stop.poi.lng != null && stop.poi.lat != null) marker.setLatLng([stop.poi.lat, stop.poi.lng])
    const icon = L.divIcon({
      className: 'tp-leaflet-marker',
      html: this._markerHtml(stop),
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    })
    marker.setIcon(icon)
  }

  private _dayStops(dayIndex: number) {
    return this.stops.filter(s => s.dayIndex === dayIndex).sort((a, b) => a.seq - b.seq)
  }

  private _renderDayRoutes(dayIndex: number) {
    for (const layer of this.dayRoutes.get(dayIndex) || []) this.map.removeLayer(layer)
    const layers: L.Layer[] = []
    const stops = this._dayStops(dayIndex)
    for (let i = 1; i < stops.length; i++) {
      layers.push(...this._routeBetween(stops[i - 1], stops[i], dayIndex))
    }
    for (const stop of stops) {
      for (const act of stop.activities) {
        if (act.type === 'long_transit' && act.transitDetail?.mode === 'flight') {
          layers.push(...this._flightArc(act.transitDetail as FlightDetail, dayIndex))
        }
      }
    }
    this.dayRoutes.set(dayIndex, layers)
    if (this.selectedDay !== 'all' && this.selectedDay !== dayIndex) {
      for (const layer of layers) this._setLayerOpacity(layer, 0.22)
    }
  }

  private _routeStyle(mode: string, dim = false): L.PolylineOptions {
    const styles: Record<string, { color: string; dashArray?: string; weight: number }> = {
      city: { color: '#64748b', weight: 2 },
      flight: { color: '#6366f1', dashArray: '9 7', weight: 2.5 },
      train: { color: '#c2410c', dashArray: '7 6', weight: 2.5 },
      self_drive: { color: '#1d6f5c', dashArray: '10 4 2 4', weight: 2.5 },
    }
    const s = styles[mode] || styles.city
    return {
      color: s.color,
      weight: s.weight,
      dashArray: s.dashArray,
      opacity: dim ? 0.22 : 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    }
  }

  private _routeBetween(a: MapStop, b: MapStop, dayIndex: number): L.Layer[] {
    if (a.poi.lng == null || a.poi.lat == null || b.poi.lng == null || b.poi.lat == null) return []
    const first = b.activities[0]
    let mode = 'city'
    let meta: any = null
    const prevLong = [...a.activities]
      .reverse()
      .find(x => x.type === 'long_transit' && x.transitDetail && destinationsMatch(x, b))
    if (first?.type === 'long_transit' && first.transitDetail) {
      mode = first.transitDetail.mode
      meta = first.transitDetail
    } else if (prevLong?.transitDetail) {
      mode = prevLong.transitDetail.mode
      meta = prevLong.transitDetail
    } else if (first?.transitFromPrev) {
      const m = first.transitFromPrev.mode
      mode = m === 'drive' && (first.transitFromPrev.distanceKm || 0) > 60 ? 'self_drive' : 'city'
      meta = first.transitFromPrev
    }
    const out: L.Layer[] = []
    const geometry = this.routePolyline.get(`${a.stopId}__${b.stopId}`)
    let labelPoint: [number, number] = [(a.poi.lat + b.poi.lat) / 2, (a.poi.lng + b.poi.lng) / 2]
    if (geometry && mode !== 'flight' && mode !== 'train') {
      const latlngs = geometry.map(point => [point[1], point[0]] as [number, number])
      // 白色描边 + 主线：更接近高德/Mapbox 的道路观感（比两点虚线「丝滑」）
      const casing = L.polyline(latlngs, {
        color: '#ffffff',
        weight: 9,
        opacity: 0.92,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(this.map)
      ;(casing as any).__tpFrom = a.stopId
      ;(casing as any).__tpTo = b.stopId
      ;(casing as any).__tpGeometry = true
      ;(casing as any).__tpCasing = true
      out.push(casing)
      const roadMode = meta?.mode === 'walk' ? 'walk' : meta?.mode === 'transit' ? 'transit' : 'drive'
      const color = roadMode === 'drive' ? '#1D6F5C' : '#2563EB'
      const dashArray = roadMode === 'walk' ? '4 6' : roadMode === 'transit' ? '10 6' : undefined
      const line = L.polyline(latlngs, {
        color,
        weight: 5,
        opacity: 0.96,
        lineCap: 'round',
        lineJoin: 'round',
        dashArray,
      }).addTo(this.map)
      ;(line as any).__tpFrom = a.stopId
      ;(line as any).__tpTo = b.stopId
      ;(line as any).__tpGeometry = true
      ;(line as any).__tpMode = mode
      out.push(line)
      const midIndex = Math.floor(latlngs.length * 0.82)
      labelPoint = latlngs[midIndex] || labelPoint
    } else if (mode === 'flight') {
      const arc = arcPoints([a.poi.lng, a.poi.lat], [b.poi.lng, b.poi.lat])
      const line = L.polyline(arc, this._routeStyle('flight')).addTo(this.map)
      ;(line as any).__tpFrom = a.stopId
      ;(line as any).__tpTo = b.stopId
      out.push(line)
      labelPoint = [a.poi.lat + (b.poi.lat - a.poi.lat) * 0.8, a.poi.lng + (b.poi.lng - a.poi.lng) * 0.8]
    } else {
      const line = L.polyline(
        [[a.poi.lat, a.poi.lng], [b.poi.lat, b.poi.lng]],
        this._routeStyle(mode),
      ).addTo(this.map)
      ;(line as any).__tpFrom = a.stopId
      ;(line as any).__tpTo = b.stopId
      out.push(line)
      labelPoint = [a.poi.lat + (b.poi.lat - a.poi.lat) * 0.8, a.poi.lng + (b.poi.lng - a.poi.lng) * 0.8]
    }
    for (const layer of out) {
      if (!(layer as any).__tpCasing) (layer as any).__tpMode = mode
    }
    const legData = this.routeLegsById.get(`${a.stopId}__${b.stopId}`)
    const label =
      mode === 'train'
        ? `🚆 ${meta?.trainNo || ''}`
        : mode === 'flight'
          ? `✈ ${meta?.flightNo || ''}`
          : legLabel(legData) || (mode === 'city' && (meta?.minutes || meta?.driveMinutes)
            ? `${meta.mode === 'walk' ? '🚶' : meta.mode === 'transit' ? '🚌' : '🚗'}${meta.minutes || Math.round(meta.driveMinutes)}分钟`
            : mode === 'self_drive' && meta?.distanceKm
              ? `🚗${Math.round(((meta.driveMinutes || meta.minutes || 0) / 60) * 10) / 10}h · ${meta.distanceKm}km`
              : null)
    if (label) {
      const tooltip = L.tooltip({
        permanent: true,
        direction: 'center',
        className: 'tp-route-label',
        opacity: 1,
      })
        .setLatLng(labelPoint)
        .setContent(label)
        .addTo(this.map)
      ;(tooltip as any).__tpRouteLabel = true
      out.push(tooltip)
    }
    return out
  }

  private _flightArc(td: FlightDetail, dayIndex: number): L.Layer[] {
    const known: Record<string, [number, number]> = {
      '乌鲁木齐地窝堡 T3': [87.47, 43.91],
      '乌鲁木齐地窝堡 T2': [87.47, 43.91],
      伊宁机场: [81.33, 43.96],
      '上海虹桥 T2': [121.34, 31.19],
      '上海浦东 T1': [121.8, 31.14],
      '大阪关西 T1': [135.24, 34.43],
    }
    const from = td.airportFrom ? known[td.airportFrom] : undefined
    const to = td.airportTo ? known[td.airportTo] : undefined
    if (!from || !to) return []
    const points = arcPoints(from, to, 0.12).map(([lng, lat]) => [lat, lng] as [number, number])
    return [L.polyline(points, this._routeStyle('flight')).addTo(this.map)]
  }

  private _renderWaypoints(trip: Trip) {
    for (const layer of this.waypoints) this.map.removeLayer(layer)
    this.waypoints = []
    for (const day of trip.days) {
      for (const stop of day.stops) {
        for (const act of stop.activities) {
          const td = act.transitDetail
          if (!td || td.mode !== 'self_drive') continue
          for (const wp of td.waypointsPoi || []) {
            const name = typeof wp === 'string' ? wp : wp.name
            const known = WAYPOINT_COORDS[name] || Object.entries(WAYPOINT_COORDS).find(([k]) => name.includes(k))?.[1]
            const coord = wp.lng != null && wp.lat != null ? [wp.lng, wp.lat] : known
            if (!coord) continue
            const circle = L.circleMarker([coord[1], coord[0]], {
              radius: 4,
              color: '#1d6f5c',
              weight: 2,
              fillColor: '#ffffff',
              fillOpacity: 1,
            }).addTo(this.map)
            ;(circle as any).__tpDay = day.dayIndex
            circle.bindTooltip(name, { direction: 'top', className: 'tp-waypoint-label' })
            this.waypoints.push(circle)
          }
        }
      }
    }
  }

  applyDayFilter(day: number | 'all') {
    this.selectedDay = day
    this._applyDayVisibility()
    if (day !== 'all') this.fitView(day)
  }

  /** 仅切换可见性（几何到达重绘后调用，避免重新 fit 抢视野）。 */
  private _applyDayVisibility() {
    const day = this.selectedDay
    const all = day === 'all'
    // 严格过滤：非当天的 marker / route 直接从地图移除，选中某天即只看当天。
    for (const stop of this.stops) {
      const marker = this.markers.get(stop.stopId)
      if (!marker) continue
      const on = all || stop.dayIndex === day
      if (on) {
        if (!this.map.hasLayer(marker)) marker.addTo(this.map)
        marker.setOpacity(1)
        marker.getElement()?.classList.remove('dimmed')
      } else if (this.map.hasLayer(marker)) {
        this.map.removeLayer(marker)
      }
    }
    for (const [dayIndex, layers] of this.dayRoutes) {
      const on = all || dayIndex === day
      for (const layer of layers) {
        if (on) {
          if (!this.map.hasLayer(layer)) layer.addTo(this.map)
        } else if (this.map.hasLayer(layer)) {
          this.map.removeLayer(layer)
        }
      }
    }
    for (const layer of this.waypoints) {
      const on = all || (layer as any).__tpDay === day
      if (on) {
        if (!this.map.hasLayer(layer)) layer.addTo(this.map)
      } else if (this.map.hasLayer(layer)) {
        this.map.removeLayer(layer)
      }
    }
    // 先移除再 addTo 会重建 marker DOM —— 高亮 class 必须重新贴一遍
    this._applyHighlight()
    this._renderCandidates()
    this._applyRouteLabelVisibility()
  }

  /** 真实道路几何到达后重绘路线（不重建 marker / 不 fit）。 */
  setRouteLegs(legs: RouteLeg[]) {
    this.routePolyline.clear()
    this.routeLegsById.clear()
    for (const leg of legs || []) {
      this.routeLegsById.set(`${leg.fromStopId}__${leg.toStopId}`, leg)
      if (Array.isArray(leg.polyline) && leg.polyline.length > 1) {
        this.routePolyline.set(`${leg.fromStopId}__${leg.toStopId}`, leg.polyline as [number, number][])
      }
    }
    for (const layers of this.dayRoutes.values()) {
      for (const layer of layers) this.map.removeLayer(layer)
    }
    this.dayRoutes.clear()
    for (const dayIndex of new Set(this.stops.map(stop => stop.dayIndex))) {
      this._renderDayRoutes(dayIndex)
    }
    this._applyDayVisibility()
  }

  private _applyRouteLabelVisibility() {
    const show = this.map.getZoom() >= 7
    for (const layers of this.dayRoutes.values()) {
      for (const layer of layers) {
        if (!(layer as any).__tpRouteLabel) continue
        const el = (layer as any).getElement?.() as HTMLElement | undefined
        if (el) el.style.display = show ? '' : 'none'
      }
    }
  }

  private _setLayerOpacity(layer: L.Layer, opacity: number) {
    const anyLayer = layer as any
    if (typeof anyLayer.setStyle === 'function' && 'options' in anyLayer) {
      anyLayer.setStyle({ opacity: opacity < 1 ? 0.22 : 0.95 })
    }
    const el = anyLayer.getElement?.() as SVGElement | HTMLElement | undefined
    if (el) el.style.opacity = String(opacity)
  }

  // ------------------------------------------------------------------
  // 候选层 / 收藏层 / 高亮层（mindtrip/06 §3、§4、§11）
  // ------------------------------------------------------------------
  private _renderCandidates() {
    this.candidateLayer.clearLayers()
    if (!this.layers.nearby || !this.candidates.length) return
    const groups = clusterCandidates(this.candidates, item => {
      if (item.lat == null || item.lng == null) return null
      const point = this.map.latLngToContainerPoint([item.lat, item.lng])
      return { x: point.x, y: point.y }
    })
    for (const group of groups) {
      const sample = firstLocated(group)
      if (!sample || sample.lat == null || sample.lng == null) continue
      const hit = this.highlightIds.size > 0 && group.items.some(item => this.highlightIds.has(item.poiId))
      const dim = this.highlightIds.size > 0 && !hit
      if (group.items.length > 1) {
        const icon = L.divIcon({
          className: 'tp-leaflet-cand-cluster',
          html: `<div class="cand-cluster ${dim ? 'dimmed' : ''} ${hit ? 'highlight-hit' : ''}">${group.items.length}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
        const marker = L.marker([sample.lat, sample.lng], { icon, zIndexOffset: 120 })
        marker.on('click', e => {
          L.DomEvent.stopPropagation(e)
          this.map.setZoom(Math.min(18, this.map.getZoom() + 2))
        })
        marker.addTo(this.candidateLayer)
        continue
      }
      const item = group.items[0]
      const icon = L.divIcon({
        className: 'tp-leaflet-cand',
        html: `<div class="cand-marker ${dim ? 'dimmed' : ''} ${hit ? 'highlight-hit' : ''}" data-poi-id="${escapeHtml(item.poiId)}">
          <span class="cand-glyph">${placeIcon(item.category)}</span>
          ${item.added ? '<span class="cand-added-dot"></span>' : '<span class="cand-plus" role="button" aria-label="加入行程">+</span>'}
        </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      })
      const marker = L.marker([item.lat as number, item.lng as number], { icon, zIndexOffset: 130 })
      marker.on('click', e => {
        L.DomEvent.stopPropagation(e)
        this.options.onCandidateClick?.(item.poiId)
      })
      marker.addTo(this.candidateLayer)
      const plus = marker.getElement()?.querySelector('.cand-plus')
      plus?.addEventListener('click', event => {
        L.DomEvent.stopPropagation(event)
        this.options.onCandidateAdd?.(item.poiId)
      })
    }
  }

  private _renderSaved() {
    this.savedLayer.clearLayers()
    if (!this.layers.saved) {
      if (this.map.hasLayer(this.savedLayer)) this.map.removeLayer(this.savedLayer)
      return
    }
    if (!this.map.hasLayer(this.savedLayer)) this.savedLayer.addTo(this.map)
    for (const item of this.savedList) {
      if (item.lat == null || item.lng == null) continue
      const icon = L.divIcon({
        className: 'tp-leaflet-saved',
        html: '<div class="saved-marker"><span class="saved-glyph">♡</span></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      })
      const marker = L.marker([item.lat, item.lng], { icon, zIndexOffset: 90 })
      marker.on('click', e => {
        L.DomEvent.stopPropagation(e)
        this.options.onCandidateClick?.(item.poiId)
      })
      marker.addTo(this.savedLayer)
    }
  }

  private _applyHighlight() {
    const active = this.highlightIds.size > 0
    for (const stop of this.stops) {
      const marker = this.markers.get(stop.stopId)
      const el = marker?.getElement()
      const hit = active && this.highlightIds.has(stop.stopId)
      el?.classList.toggle('dimmed', active && !hit)
      el?.classList.toggle('highlight-hit', hit)
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
    this.candidateLayer.clearLayers()
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
      if (layers.trip) {
        if (this.selectedDay === 'all' || this.selectedDay === stop.dayIndex) {
          if (!this.map.hasLayer(marker)) marker.addTo(this.map)
        }
      } else if (this.map.hasLayer(marker)) {
        this.map.removeLayer(marker)
      }
    }
    for (const [dayIndex, layersOfDay] of this.dayRoutes) {
      const on = layers.trip && (this.selectedDay === 'all' || this.selectedDay === dayIndex)
      for (const layer of layersOfDay) {
        if (on && !this.map.hasLayer(layer)) layer.addTo(this.map)
        if (!on && this.map.hasLayer(layer)) this.map.removeLayer(layer)
      }
    }
    this._applyHighlight()
    this._renderCandidates()
    this._renderSaved()
  }

  highlightLeg(fromStopId: string, toStopId: string) {
    for (const layers of this.dayRoutes.values()) {
      for (const layer of layers) {
        const anyLayer = layer as any
        if (typeof anyLayer.setStyle !== 'function') continue
        const hit = anyLayer.__tpFrom === fromStopId && anyLayer.__tpTo === toStopId
        if (anyLayer.__tpGeometry) {
          anyLayer.setStyle(hit ? { opacity: 1, weight: anyLayer.__tpCasing ? 9 : 6 } : { opacity: anyLayer.__tpCasing ? 0.12 : 0.18 })
          continue
        }
        anyLayer.setStyle(hit ? { weight: 4, opacity: 1 } : { opacity: 0.18 })
      }
    }
  }

  clearLegHighlight() {
    for (const layers of this.dayRoutes.values()) {
      for (const layer of layers) {
        const anyLayer = layer as any
        if (typeof anyLayer.setStyle !== 'function') continue
        if (anyLayer.__tpGeometry) {
          anyLayer.setStyle({ opacity: anyLayer.__tpCasing ? 0.92 : 0.96, weight: anyLayer.__tpCasing ? 9 : 5 })
          continue
        }
        const mode = anyLayer.__tpMode || 'city'
        anyLayer.setStyle({ ...this._routeStyle(mode), opacity: 0.95 })
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
    const center = this.map.getCenter()
    return { lng: center.lng, lat: center.lat }
  }

  focusPlace(poiId: string, opts: { zoom?: number } = {}) {
    const place = this._locatePlace(poiId)
    if (!place) return
    const zoom = Math.max(14, Math.min(17, opts.zoom ?? 14))
    const size = this.map.getSize()
    const inset = Math.min(this.rightInset, size.x * 0.52)
    const bottom = Math.min(this.bottomInset, size.y * 0.7)
    const target = this.map.project([place.lat, place.lng], zoom)
    const wanted = L.point((size.x - inset) / 2, (size.y - bottom) / 2)
    const center = target.add(L.point(size.x / 2 - wanted.x, size.y / 2 - wanted.y))
    this.map.setView(this.map.unproject(center, zoom), zoom, { animate: true })
  }

  fitView(day: number | 'all' | null) {
    const stops = this.stops.filter(s => (day === 'all' || day == null ? true : s.dayIndex === day))
    const coords = stops
      .filter(s => s.poi.lng != null && s.poi.lat != null)
      .map(s => [s.poi.lat as number, s.poi.lng as number] as [number, number])
    if (!coords.length) return
    if (coords.length === 1) {
      this.map.setView(coords[0], Math.max(this.map.getZoom(), 10), { animate: false })
      return
    }
    const bounds = L.latLngBounds(coords)
    this.map.fitBounds(bounds, {
      paddingTopLeft: [64, 150],
      paddingBottomRight: [Math.max(56, this.rightInset + 56), Math.max(96, this.bottomInset + 96)],
      maxZoom: 12,
      animate: false,
    })
  }

  zoomBy(factor: number) {
    const z = this.map.getZoom()
    this.map.setZoom(Math.min(18, Math.max(3, z + (factor > 1 ? 1 : -1))))
  }

  screenPos(stopId: string) {
    const stop = this.stops.find(s => s.stopId === stopId)
    if (!stop || stop.poi.lng == null || stop.poi.lat == null) return null
    const p = this.map.latLngToContainerPoint([stop.poi.lat, stop.poi.lng])
    return { x: p.x, y: p.y }
  }

  centerOn(stopId: string) {
    const stop = this.stops.find(s => s.stopId === stopId)
    if (!stop || stop.poi.lng == null || stop.poi.lat == null) return
    const zoom = Math.max(this.map.getZoom(), 8)
    const size = this.map.getSize()
    const inset = Math.min(this.rightInset, size.x * 0.52)
    const bottom = Math.min(this.bottomInset, size.y * 0.7)
    const target = this.map.project([stop.poi.lat, stop.poi.lng], zoom)
    const wanted = L.point(
      (size.x - inset) / 2,
      (size.y - bottom) / 2,
    )
    const center = target.add(L.point(size.x / 2 - wanted.x, size.y / 2 - wanted.y))
    this.map.setView(this.map.unproject(center, zoom), zoom, { animate: true })
  }

  selectStop(stopId: string | null, fromMap = false) {
    this.selectedStop = stopId
    for (const [id, marker] of this.markers) {
      const el = marker.getElement()
      el?.classList.toggle('selected', id === stopId)
    }
    if (fromMap && stopId) this.options.onMarkerClick?.(stopId)
  }

  clearSelection() {
    this.selectStop(null)
  }

  pulseMarker(stopId: string) {
    const marker = this.markers.get(stopId)
    const el = marker?.getElement()
    const pin = el?.querySelector('.tp-leaflet-pin')
    if (!pin) return
    pin.classList.remove('pulse')
    void (pin as HTMLElement).offsetWidth
    pin.classList.add('pulse')
    window.setTimeout(() => pin.classList.remove('pulse'), 1300)
  }

  addDiffTag(stopId: string, text: string) {
    this.diffTags.set(stopId, text)
    const stop = this.stops.find(s => s.stopId === stopId)
    if (stop) this._refreshMarker(stop)
  }

  setRightInset(px: number) {
    this.rightInset = Math.max(0, px)
  }

  setBottomInset(px: number) {
    this.bottomInset = Math.max(0, px)
  }

  syncTrip(trip: Trip, changedDays: number[] = [], diff: DiffEntry[] = []) {
    const next = new Map<string, MapStop>()
    for (const day of trip.days) for (const stop of day.stops) next.set(stop.stopId, { ...stop, dayIndex: day.dayIndex })
    const removedDays = new Set<number>()
    for (const [id, old] of [...this.markers]) {
      if (!next.has(id)) {
        const oldStop = this.stops.find(s => s.stopId === id)
        if (oldStop) removedDays.add(oldStop.dayIndex)
        this.map.removeLayer(old)
        this.markers.delete(id)
      }
    }
    this.stops = [...next.values()]
    for (const stop of this.stops) this._refreshMarker(stop)
    const rebuild = new Set([...changedDays, ...removedDays])
    for (const dayIndex of rebuild) this._renderDayRoutes(dayIndex)
    this._renderWaypoints(trip)
    this._applyHighlight()
    this._renderCandidates()
    this._renderSaved()
    for (const entry of diff) {
      if (entry.stopId) {
        this.pulseMarker(entry.stopId)
        if (entry.label) this.addDiffTag(entry.stopId, entry.label)
      }
      if (entry.activityId) {
        const stop = this.stops.find(s => s.activities.some(a => a.activityId === entry.activityId))
        if (stop) {
          this.pulseMarker(stop.stopId)
          if (entry.label) this.addDiffTag(stop.stopId, entry.label)
        }
      }
    }
    if (this.selectedDay !== 'all') this.applyDayFilter(this.selectedDay)
  }

  destroy() {
    this.candidateLayer.clearLayers()
    this.savedLayer.clearLayers()
    this.themeObserver?.disconnect()
    this.resizeObserver?.disconnect()
    this.map.remove()
    this.container.innerHTML = ''
  }
}

function arcPoints(from: [number, number], to: [number, number], lift = 0.18): [number, number][] {
  const mid: [number, number] = [
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2 + Math.max(0.4, Math.abs(to[0] - from[0]) * lift),
  ]
  const points: [number, number][] = []
  for (let i = 0; i <= 24; i++) {
    const t = i / 24
    const a = (1 - t) * (1 - t)
    const b = 2 * (1 - t) * t
    const c = t * t
    points.push([a * from[0] + b * mid[0] + c * to[0], a * from[1] + b * mid[1] + c * to[1]])
  }
  return points
}

function destinationsMatch(activity: { title: string; transitDetail?: any }, stop: MapStop) {
  const detail = activity.transitDetail || {}
  const targets = [detail.airportTo, detail.stationTo, activity.title.split('→').pop() || '']
    .filter(Boolean)
    .map((s: string) => s.replace(/[市县区]$/, '').trim())
  const names = [stop.poi.city || '', stop.poi.name.split(' · ')[0]]
    .filter(Boolean)
    .map(s => s.replace(/[市县区]$/, '').trim())
  return targets.some((target: string) => names.some(name => target.includes(name) || name.includes(target)))
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
