/* SVG map canvas — the offline / no-key implementation of the §3.4 canvas
   contract.  Real AMap 2.0 is used when an AMAP_JS_KEY is configured; both
   adapters expose the same imperative controller (see MapPane.tsx). */

import type {
  CandidatePlace,
  Day,
  DiffEntry,
  FlightDetail,
  MapLayers,
  RouteLeg,
  SavedPlace,
  SelfDriveDetail,
  Stop,
  TransitDetail,
  Trip,
} from '../types'
import { dayColorVar, fmtHM, shortName, timeDiff } from '../lib/format'
import { placeIcon } from '../lib/placeMeta'
import { clusterCandidates, firstLocated } from './layers/candidates'
import { legLabel } from './layers/routeLabel'

const W = { lng0: 78.4, lat0: 50.2, scale: 62, latStretch: 1.42 }

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export function project(lng: number, lat: number) {
  return { x: (lng - W.lng0) * W.scale, y: (W.lat0 - lat) * W.scale * W.latStretch }
}

function poly(points: [number, number][], cls: string) {
  const d = points.map(p => project(p[0], p[1])).map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ') + ' Z'
  return `<path class="${cls}" d="${d}"/>`
}
function line(points: [number, number][], cls: string) {
  const d = points.map(p => project(p[0], p[1])).map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')
  return `<path class="${cls}" d="${d}"/>`
}
function label(lng: number, lat: number, text: string, anchor = 'middle') {
  const q = project(lng, lat)
  return `<text class="map-basemap-label" x="${q.x.toFixed(1)}" y="${q.y.toFixed(1)}" text-anchor="${anchor}">${esc(text)}</text>`
}

function basemap() {
  let g = ''
  for (let lng = 80; lng <= 92; lng += 2) g += line([[lng, 41], [lng, 50]], 'map-basemap-grid')
  for (let lat = 42; lat <= 49; lat += 1.5) g += line([[79, lat], [93, lat]], 'map-basemap-grid')
  g += poly([[80, 41.6], [92, 41.4], [92.5, 40.5], [79.5, 40.5]], 'map-basemap-desert')
  g += poly([[80.2, 43.2], [84, 42.6], [88, 42.6], [91.5, 43.1], [91.5, 42.2], [87, 41.9], [82, 42.1], [80.2, 42.6]], 'map-basemap-mountain')
  g += poly([[85.2, 48.6], [88, 49.1], [90.8, 48.8], [90.6, 48.0], [87.5, 48.3], [85.4, 47.9]], 'map-basemap-mountain')
  g += poly([[81.05, 44.72], [81.32, 44.70], [81.30, 44.50], [81.05, 44.52]], 'map-basemap-water')
  g += poly([[82.2, 45.1], [82.8, 45.05], [82.7, 44.8], [82.2, 44.85]], 'map-basemap-water')
  g += poly([[86.9, 47.5], [87.9, 47.45], [87.8, 47.05], [86.9, 47.1]], 'map-basemap-water')
  g += poly([[86.2, 42.1], [87.0, 42.05], [86.9, 41.8], [86.2, 41.85]], 'map-basemap-water')
  const g30 = [[87.62, 43.79], [86.2, 44.15], [84.9, 44.43], [83.2, 44.72], [81.6, 44.85], [81.17, 44.61], [80.6, 44.3], [81.33, 43.92]] as [number, number][]
  const g216 = [[87.62, 43.79], [88.1, 44.6], [89.1, 45.9], [89.55, 46.99], [88.14, 47.85]] as [number, number][]
  const g217 = [[84.9, 44.43], [85.35, 45.3], [85.69, 46.1], [86.6, 46.9], [87.4, 47.4]] as [number, number][]
  const g218 = [[81.33, 43.92], [81.84, 43.21], [82.5, 42.9], [84.1, 43.3], [86.2, 44.15]] as [number, number][]
  for (const r of [g30, g216, g217, g218]) {
    g += line(r, 'map-basemap-road-casing')
    g += line(r, 'map-basemap-road')
  }
  g += label(87.62, 43.62, '乌鲁木齐')
  g += label(85.35, 45.15, '克拉玛依')
  g += label(88.35, 47.85, '阿勒泰', 'start')
  g += label(80.95, 43.78, '伊宁')
  g += label(84.72, 44.28, '奎屯')
  g += label(81.55, 45.02, '博乐')
  g += label(89.9, 46.92, '富蕴', 'start')
  return g
}

/** Neutral grid + city labels for trips outside the Xinjiang basemap.
    Keeps the canvas useful for the archived Yunnan / Kansai / Anji examples. */
function genericBasemap(stops: MapStop[]) {
  const coords = stops
    .filter(s => s.poi.lng != null && s.poi.lat != null)
    .map(s => [s.poi.lng as number, s.poi.lat as number] as [number, number])
  if (!coords.length) return ''
  const lngs = coords.map(c => c[0])
  const lats = coords.map(c => c[1])
  const minLng = Math.floor(Math.min(...lngs) - 1)
  const maxLng = Math.ceil(Math.max(...lngs) + 1)
  const minLat = Math.floor(Math.min(...lats) - 1)
  const maxLat = Math.ceil(Math.max(...lats) + 1)
  let g = ''
  for (let lng = minLng; lng <= maxLng; lng += 1) {
    g += line([[lng, minLat], [lng, maxLat]], 'map-basemap-grid')
  }
  for (let lat = minLat; lat <= maxLat; lat += 1) {
    g += line([[minLng, lat], [maxLng, lat]], 'map-basemap-grid')
  }
  const seen = new Set<string>()
  for (const stop of stops) {
    const city = stop.poi.city || ''
    if (!city || seen.has(city) || stop.poi.lng == null || stop.poi.lat == null) continue
    seen.add(city)
    g += label(stop.poi.lng + 0.08, stop.poi.lat + 0.08, city, 'start')
  }
  return g
}

function isXinjiangTrip(stops: MapStop[]) {
  return stops.every(
    s =>
      s.poi.lng != null &&
      s.poi.lat != null &&
      s.poi.lng >= 78 &&
      s.poi.lng <= 93.5 &&
      s.poi.lat >= 40 &&
      s.poi.lat <= 50.5,
  )
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

const WAYPOINT_COORDS = [
  { name: '果子沟大桥', lng: 81.62, lat: 44.47 },
  { name: '独库公路天瀑', lng: 84.62, lat: 43.72 },
  { name: '恰库尔图', lng: 89.13, lat: 45.92 },
  { name: '五彩湾', lng: 88.42, lat: 44.98 },
]

export interface MapStop extends Stop {
  dayIndex: number
}

interface Segment {
  g: SVGGElement
  dayIndex: number
  from: string
  to: string
  mode: string
}

export interface MapCanvasOptions {
  interactive?: boolean
  onMarkerClick?: (stopId: string) => void
  onBlankClick?: () => void
  onRouteClick?: (payload: unknown) => void
  /** 候选点点击（打开浮卡）；加入动作在浮卡里完成 */
  onCandidateClick?: (poiId: string) => void
  /** 候选点上的小 ＋：一键加入当前天（§4.2「候选 click 浮卡；＋ 加入」） */
  onCandidateAdd?: (poiId: string) => void
}

export class MapCanvas {
  container: HTMLElement
  opts: MapCanvasOptions
  zoom = 1
  tx = 0
  ty = 0
  stops: MapStop[] = []
  waypoints: { name: string; lng: number; lat: number; dayIndex: number }[] = []
  segments: Segment[] = []
  selectedDay: number | 'all' = 'all'
  selectedStop: string | null = null
  diffTags: Record<string, string> = {}
  rightInset = 0
  bottomInset = 0
  svg: SVGSVGElement
  viewport: SVGGElement
  routesLayer: SVGGElement
  candidateLayer: SVGGElement
  markersLayer: SVGGElement
  savedLayer: SVGGElement
  overlayLayer: SVGGElement
  candidates: CandidatePlace[] = []
  savedList: SavedPlace[] = []
  routePolyline = new Map<string, [number, number][]>()
  routeLegsById = new Map<string, RouteLeg>()
  highlightIds: Set<string> = new Set()
  layers: MapLayers = { trip: true, nearby: true, saved: false }
  private candidateClusterKeys = new Map<string, string>()
  private drag: { x: number; y: number; tx: number; ty: number } | null = null

  constructor(container: HTMLElement, opts: MapCanvasOptions = {}) {
    this.container = container
    this.opts = { interactive: true, ...opts }
    container.classList.add('map-canvas')
    container.innerHTML = `
      <svg class="map-svg" aria-label="行程地图">
        <g class="viewport">
          <g class="layer-basemap">${basemap()}</g>
          <g class="layer-routes"></g>
          <g class="layer-candidates"></g>
          <g class="layer-markers"></g>
          <g class="layer-saved"></g>
          <g class="layer-overlay"></g>
        </g>
      </svg>`
    this.svg = container.querySelector('svg') as SVGSVGElement
    this.viewport = container.querySelector('.viewport') as SVGGElement
    this.routesLayer = container.querySelector('.layer-routes') as SVGGElement
    this.candidateLayer = container.querySelector('.layer-candidates') as SVGGElement
    this.markersLayer = container.querySelector('.layer-markers') as SVGGElement
    this.savedLayer = container.querySelector('.layer-saved') as SVGGElement
    this.overlayLayer = container.querySelector('.layer-overlay') as SVGGElement
    this._applyTransform()
    if (this.opts.interactive) this._bindGestures()
  }

  _applyTransform() {
    this.viewport.setAttribute(
      'transform',
      `translate(${this.tx.toFixed(1)},${this.ty.toFixed(1)}) scale(${this.zoom.toFixed(3)})`,
    )
    this._applyConstantScreenSize()
    // 缩小时隐藏路线文字，避免整张图都是「xx km」标签（§4.2 只保留候选/行程/路线）
    this._applyRouteLabelVisibility()
    this.container.dispatchEvent(new CustomEvent('tp-map-transform'))
  }

  /** Keep marker icons, names and route labels at a constant screen size. */
  _applyConstantScreenSize() {
    const inv = 1 / this.zoom
    this.markersLayer.querySelectorAll<SVGGElement>('.marker-inner, .waypoint-inner').forEach(el => {
      el.setAttribute('transform', `scale(${inv.toFixed(4)})`)
    })
    this.candidateLayer
      .querySelectorAll<SVGGElement>('.cand-inner, .cand-cluster-inner')
      .forEach(el => el.setAttribute('transform', `scale(${inv.toFixed(4)})`))
    this.savedLayer
      .querySelectorAll<SVGGElement>('.saved-inner')
      .forEach(el => el.setAttribute('transform', `scale(${inv.toFixed(4)})`))
    this.routesLayer.querySelectorAll<SVGGElement>('.route-label').forEach(el => {
      const x = el.dataset.x || '0'
      const y = el.dataset.y || '0'
      el.setAttribute('transform', `translate(${x},${y}) scale(${inv.toFixed(4)})`)
    })
    this.container.querySelectorAll<SVGTextElement>('.layer-basemap .map-basemap-label').forEach(el => {
      el.style.fontSize = `${(12 * inv).toFixed(2)}px`
    })
    // Greedy label collision: keep the first label in each screen-space cell.
    const occupied: { x: number; y: number }[] = []
    for (const stop of this.stops) {
      const marker = this.markersLayer.querySelector<SVGGElement>(`.marker[data-stop-id="${CSS.escape(stop.stopId)}"]`)
      if (!marker) continue
      const p = project(stop.poi.lng || 0, stop.poi.lat || 0)
      const sx = p.x * this.zoom + this.tx
      const sy = p.y * this.zoom + this.ty
      const collides = occupied.some(o => Math.abs(o.x - sx) < 62 && Math.abs(o.y - sy) < 30)
      marker.classList.toggle('label-hidden', collides)
      if (!collides) occupied.push({ x: sx, y: sy })
    }
  }

  setTrip(trip: Trip) {
    this.stops = []
    this.waypoints = []
    for (const day of trip.days) {
      for (const stop of day.stops) {
        this.stops.push({ ...stop, dayIndex: day.dayIndex })
        for (const act of stop.activities) {
          const td = act.transitDetail
          if (td && td.mode === 'self_drive') {
            for (const wp of (td as SelfDriveDetail).waypointsPoi || []) {
              const name = typeof wp === 'string' ? wp : wp.name
              const known = WAYPOINT_COORDS.find(
                w => name.includes(w.name) || w.name.includes(name),
              )
              if (known) this.waypoints.push({ ...known, dayIndex: day.dayIndex })
              else if (typeof wp !== 'string' && wp.lng != null && wp.lat != null)
                this.waypoints.push({ name, lng: wp.lng, lat: wp.lat, dayIndex: day.dayIndex })
            }
          }
        }
      }
    }
    const basemapLayer = this.container.querySelector('.layer-basemap')
    if (basemapLayer) {
      basemapLayer.innerHTML = isXinjiangTrip(this.stops) ? basemap() : genericBasemap(this.stops)
    }
    this.renderAll()
    this.fitView('all')
  }

  renderAll() {
    this.routesLayer.innerHTML = ''
    this.markersLayer.innerHTML = ''
    this.segments = []
    const days = [...new Set(this.stops.map(s => s.dayIndex))].sort((a, b) => a - b)
    for (const dayIndex of days) this._renderDayRoutes(dayIndex)
    for (const stop of this.stops) this._renderMarker(stop)
    for (const w of this.waypoints) this._renderWaypoint(w)
    this._renderCandidates()
    this._renderSaved()
    this.applyDayFilter(this.selectedDay)
    this._applyHighlight()
  }

  _dayStops(dayIndex: number) {
    return this.stops
      .filter(s => s.dayIndex === dayIndex)
      .sort((a, b) => a.seq - b.seq)
  }

  _renderDayRoutes(dayIndex: number) {
    const dayStops = this._dayStops(dayIndex)
    for (let i = 1; i < dayStops.length; i++) {
      this._renderSegment(dayStops[i - 1], dayStops[i], dayIndex)
    }
    for (const s of dayStops) {
      for (const a of s.activities) {
        if (a.type === 'long_transit' && a.transitDetail?.mode === 'flight') {
          this._renderFlightActivity(a.transitDetail, dayIndex)
        }
      }
    }
  }

  _rebuildDayRoutes(dayIndex: number) {
    for (const sg of [...this.segments]) {
      if (sg.dayIndex === dayIndex) {
        sg.g.remove()
        this.segments = this.segments.filter(x => x !== sg)
      }
    }
    this._renderDayRoutes(dayIndex)
    if (this.selectedDay !== 'all') this.applyDayFilter(this.selectedDay)
  }

  _renderFlightActivity(td: TransitDetail, dayIdx: number) {
    if (td.mode !== 'flight') return
    const flight = td as FlightDetail
    const known: Record<string, [number, number]> = {
      '乌鲁木齐地窝堡 T3': [87.47, 43.91],
      '乌鲁木齐地窝堡 T2': [87.47, 43.91],
      '乌鲁木齐地窝堡 T3 ': [87.47, 43.91],
      伊宁机场: [81.33, 43.96],
      '上海虹桥 T2': [121.34, 31.19],
    }
    const from = flight.airportFrom ? known[flight.airportFrom] : undefined
    const to = flight.airportTo ? known[flight.airportTo] : undefined
    if (!from || !to) return
    const clamp = (c: [number, number], other: [number, number]): [number, number] => {
      if (c[0] <= 93.2 && c[0] >= 78.6) return c
      const k = (93.6 - other[0]) / (c[0] - other[0])
      return [93.6, other[1] + (c[1] - other[1]) * k]
    }
    const a = project(...clamp(from, to))
    const b = project(...clamp(to, from))
    this._renderFlightArc(a, b, flight, dayIdx)
  }

  _renderFlightArc(a: { x: number; y: number }, b: { x: number; y: number }, meta: FlightDetail, dayIdx: number) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'segment')
    g.dataset.day = String(dayIdx)
    const mx = a.x + (b.x - a.x) * 0.8
    const my = a.y + (b.y - a.y) * 0.8
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const lift = Math.min(90, len * 0.24)
    const cx = mx - (dy / len) * lift
    const cy = my + (dx / len) * lift
    const d = `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`
    g.insertAdjacentHTML('afterbegin', `<path class="route-hit" d="${d}"/><path class="route-flight route-path" d="${d}"/>`)
    const qx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x
    const qy = 0.25 * a.y + 0.5 * cy + 0.25 * b.y
    const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI - 90
    g.insertAdjacentHTML(
      'beforeend',
      `<g transform="translate(${qx.toFixed(1)},${qy.toFixed(1)}) rotate(${ang.toFixed(0)})">
        <circle r="9" fill="var(--bg)" stroke="var(--line-flight)" stroke-width="1.5"/>
        <g transform="translate(-5,-5) scale(0.42)" fill="var(--line-flight)" stroke="none">
          <path d="M10.2 13.8 3 11.4l1.6-1.6 7.3.6 4.4-4.4a2 2 0 1 1 2.8 2.8l-4.4 4.4.6 7.3-1.6 1.6-2.4-7.2-3.2 3.2.3 2.7-1.3.6-2-3.1-3-2 .5-1.3 2.7.3 3.2-3.2Z"/>
        </g>
      </g>`,
    )
    if (meta.flightNo) {
      const durMin = timeDiff(meta.depTime, meta.arrTime)
      this._routeLabel(g, qx, qy - 16, `✈ ${meta.flightNo} · ${Math.floor(durMin / 60)}h${String(durMin % 60).padStart(2, '0')}m`)
    }
    g.dataset.from = 'flight-' + (meta.flightNo || dayIdx)
    g.dataset.to = meta.airportTo || ''
    this.routesLayer.appendChild(g)
    this.segments.push({ g, dayIndex: dayIdx, from: g.dataset.from, to: g.dataset.to, mode: 'flight' })
  }

  _renderSegment(fromStop: MapStop, toStop: MapStop, dayIdx: number) {
    const firstAct = toStop.activities[0]
    let mode = 'city'
    let meta: any = null
    const prevLong = [...fromStop.activities]
      .reverse()
      .find(a => a.type === 'long_transit' && a.transitDetail && destinationsMatch(a, toStop))
    if (firstAct && firstAct.type === 'long_transit' && firstAct.transitDetail) {
      mode = firstAct.transitDetail.mode
      meta = firstAct.transitDetail
    } else if (prevLong && prevLong.transitDetail) {
      mode = prevLong.transitDetail.mode
      meta = prevLong.transitDetail
    } else if (firstAct && firstAct.transitFromPrev) {
      const m = firstAct.transitFromPrev.mode
      mode = m === 'drive' && (firstAct.transitFromPrev.distanceKm || 0) > 60 ? 'self_drive' : 'city'
      meta = firstAct.transitFromPrev
    }
    const a = project(fromStop.poi.lng || 0, fromStop.poi.lat || 0)
    const b = project(toStop.poi.lng || 0, toStop.poi.lat || 0)
    const cls =
      ({ city: 'route-city', flight: 'route-flight', train: 'route-train', self_drive: 'route-drive' } as Record<string, string>)[mode] ||
      'route-city'
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'segment')
    g.dataset.day = String(dayIdx)
    // 真实道路几何（mindtrip/06 §5 / 04-replicate W2）：drive/walk/transit 走 polyline，
    // 没有几何时才退回两点一线，并在信息条标「示意」。
    const geometry = this.routePolyline.get(`${fromStop.stopId}__${toStop.stopId}`)
    const roadMode = (meta && typeof meta.mode === 'string' ? meta.mode : mode === 'self_drive' ? 'drive' : 'drive') as string
    if (geometry && mode !== 'flight' && mode !== 'train') {
      const dGeom = geometry
        .map((point, index) => {
          const q = project(point[0], point[1])
          return `${index ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`
        })
        .join(' ')
      g.insertAdjacentHTML(
        'afterbegin',
        `<path class="route-hit" d="${dGeom}"/><path class="route-casing" d="${dGeom}"/><path class="route-road mode-${esc(roadMode)} route-path" d="${dGeom}"/>`,
      )
      const mid = geometry[Math.floor(geometry.length * 0.82)]
      const labelPoint = project(mid[0], mid[1])
      const legData = this.routeLegsById.get(`${fromStop.stopId}__${toStop.stopId}`)
      const label = legLabel(legData) || (mode === 'city' && meta && meta.minutes
        ? `${meta.mode === 'walk' ? '🚶' : meta.mode === 'transit' ? '🚌' : '🚗'}${meta.minutes}分钟`
        : mode === 'self_drive' && meta && meta.distanceKm
          ? `🚗${Math.round((((meta.driveMinutes || meta.minutes || 0) / 60) * 10)) / 10}h · ${meta.distanceKm}km`
          : null)
      if (label) this._routeLabel(g, labelPoint.x, labelPoint.y, label)
      g.dataset.from = fromStop.stopId
      g.dataset.to = toStop.stopId
      this.routesLayer.appendChild(g)
      this.segments.push({ g, dayIndex: dayIdx, from: fromStop.stopId, to: toStop.stopId, mode })
      if (this.opts.onRouteClick) {
        g.querySelector('.route-hit')?.addEventListener('click', e => {
          e.stopPropagation()
          this.opts.onRouteClick?.({ from: fromStop, to: toStop, dayIdx, mode, meta, geometry: true })
        })
      }
      return
    }
    let d: string
    if (mode === 'flight') {
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const lift = Math.min(90, len * 0.28)
      const cx = mx - (dy / len) * lift
      const cy = my + (dx / len) * lift
      d = `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`
      const qx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x
      const qy = 0.25 * a.y + 0.5 * cy + 0.25 * b.y
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI - 90
      g.insertAdjacentHTML(
        'beforeend',
        `<g transform="translate(${qx.toFixed(1)},${qy.toFixed(1)}) rotate(${ang.toFixed(0)})">
          <circle r="9" fill="var(--bg)" stroke="var(--line-flight)" stroke-width="1.5"/>
          <g transform="translate(-5,-5) scale(0.42)" fill="var(--line-flight)" stroke="none">
            <path d="M10.2 13.8 3 11.4l1.6-1.6 7.3.6 4.4-4.4a2 2 0 1 1 2.8 2.8l-4.4 4.4.6 7.3-1.6 1.6-2.4-7.2-3.2 3.2.3 2.7-1.3.6-2-3.1-3-2 .5-1.3 2.7.3 3.2-3.2Z"/>
          </g>
        </g>`,
      )
      if (meta && meta.flightNo) {
        const durMin = timeDiff(meta.depTime, meta.arrTime)
        this._routeLabel(g, qx, qy - 16, `✈ ${meta.flightNo} · ${Math.floor(durMin / 60)}h${String(durMin % 60).padStart(2, '0')}m`)
      }
    } else if (mode === 'train') {
      d = `M${a.x},${a.y} L${b.x},${b.y}`
    } else {
      const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.06
      const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.06
      d = `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`
    }
    g.insertAdjacentHTML('afterbegin', `<path class="route-hit" d="${d}"/><path class="${cls} route-path" d="${d}"/>`)
    const mx = a.x + (b.x - a.x) * 0.8
    const my = a.y + (b.y - a.y) * 0.8
    const legData = this.routeLegsById.get(`${fromStop.stopId}__${toStop.stopId}`)
    const fallbackLabel = legLabel(legData) || (mode === 'city' && meta && meta.minutes
      ? `${meta.mode === 'walk' ? '🚶' : meta.mode === 'transit' ? '🚌' : '🚗'}${meta.minutes}分钟`
      : mode === 'self_drive' && meta && meta.distanceKm
        ? `🚗${Math.round((((meta.driveMinutes || meta.minutes || 0) / 60) * 10)) / 10}h · ${meta.distanceKm}km`
        : null)
    if (fallbackLabel) this._routeLabel(g, mx, my, fallbackLabel)
    g.dataset.from = fromStop.stopId
    g.dataset.to = toStop.stopId
    this.routesLayer.appendChild(g)
    this.segments.push({ g, dayIndex: dayIdx, from: fromStop.stopId, to: toStop.stopId, mode })
    if (this.opts.onRouteClick) {
      g.querySelector('.route-hit')?.addEventListener('click', e => {
        e.stopPropagation()
        this.opts.onRouteClick?.({ from: fromStop, to: toStop, dayIdx, mode, meta })
      })
    }
  }

  _routeLabel(g: SVGGElement, x: number, y: number, text: string) {
    const w = text.length * 6.6 + 12
    g.insertAdjacentHTML(
      'beforeend',
      `<g class="route-label" data-x="${x.toFixed(1)}" data-y="${y.toFixed(1)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${(1 / this.zoom).toFixed(4)})">
        <rect class="route-label-bg" x="${(-w / 2).toFixed(1)}" y="-8" width="${w.toFixed(1)}" height="16" rx="4"/>
        <text class="route-label-text" x="0" y="0" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>
      </g>`,
    )
  }

  _renderMarker(stop: MapStop) {
    const p = project(stop.poi.lng || 0, stop.poi.lat || 0)
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'marker')
    g.dataset.stopId = stop.stopId
    g.dataset.day = String(stop.dayIndex)
    g.style.setProperty('--day-color', dayColorVar(stop.dayIndex))
    g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`)
    g.innerHTML = `
      <g class="marker-inner">
        <g class="marker-pin">
          <circle class="pin-bg" r="13"/>
          <text class="pin-num" y="0.5">${stop.seq}</text>
        </g>
        <text class="marker-name" x="0" y="${stop.seq % 2 ? 28 : -22}" text-anchor="middle">${esc(shortName(stop.poi.name))}</text>
      </g>`
    g.setAttribute('tabindex', '0')
    g.setAttribute('role', 'button')
    g.setAttribute('aria-label', `Day ${stop.dayIndex} 第${stop.seq}站 ${stop.poi.name}`)
    const click = (e: Event) => {
      e.stopPropagation()
      this.selectStop(stop.stopId, true)
    }
    g.addEventListener('click', click)
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        click(e)
      }
    })
    this.markersLayer.appendChild(g)
  }

  // ------------------------------------------------------------------
  // 候选层 / 收藏层 / 高亮层（mindtrip/06 §3、§4、§11）
  // ------------------------------------------------------------------
  _projectScreen(item: { lat?: number | null; lng?: number | null }) {
    if (item.lat == null || item.lng == null) return null
    const point = project(item.lng, item.lat)
    return { x: point.x * this.zoom + this.tx, y: point.y * this.zoom + this.ty }
  }

  _renderCandidates() {
    this.candidateLayer.innerHTML = ''
    this.candidateClusterKeys.clear()
    if (!this.layers.nearby || !this.candidates.length) return
    const groups = clusterCandidates(this.candidates, item => this._projectScreen(item))
    for (const group of groups) {
      const sample = firstLocated(group)
      if (!sample) continue
      const point = project(sample.lng as number, sample.lat as number)
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('class', 'cand-marker')
      g.setAttribute('role', 'button')
      g.setAttribute('tabindex', '0')
      const hit = this.highlightIds.size > 0 && group.items.some(item => this.highlightIds.has(item.poiId))
      const dim = this.highlightIds.size > 0 && !hit
      if (dim) g.classList.add('dimmed')
      if (hit) g.classList.add('highlight-hit')
      if (group.items.length > 1) {
        g.classList.add('is-cluster')
        g.setAttribute('transform', `translate(${point.x.toFixed(1)},${point.y.toFixed(1)})`)
        g.innerHTML = `<g class="cand-cluster-inner"><circle class="cand-cluster-bg" r="14"/>
          <text class="cand-cluster-count" y="0.5">${group.items.length}</text></g>`
        g.setAttribute('aria-label', `${group.items.length} 个候选地点，点击放大`)
        g.addEventListener('click', e => {
          e.stopPropagation()
          this.zoomBy(1.6)
        })
        this.candidateLayer.appendChild(g)
        continue
      }
      const item = group.items[0]
      g.setAttribute('transform', `translate(${point.x.toFixed(1)},${point.y.toFixed(1)})`)
      g.dataset.poiId = item.poiId
      g.innerHTML = `<g class="cand-inner">
          <circle class="cand-bg" r="12"/>
          <text class="cand-glyph" y="0.5">${esc(placeIcon(item.category))}</text>
          ${item.added ? '<circle class="cand-added-dot" cx="9" cy="-9" r="5"/>' : '<g class="cand-plus" transform="translate(9,-9)"><circle r="6.5"/><text y="0.5">+</text></g>'}
        </g>`
      g.querySelector('.cand-plus')?.addEventListener('click', e => {
        e.stopPropagation()
        this.opts.onCandidateAdd?.(item.poiId)
      })
      g.setAttribute('aria-label', `候选地点 ${item.name}`)
      g.addEventListener('click', e => {
        e.stopPropagation()
        this.opts.onCandidateClick?.(item.poiId)
      })
      g.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          this.opts.onCandidateClick?.(item.poiId)
        }
      })
      this.candidateLayer.appendChild(g)
    }
  }

  _renderSaved() {
    this.savedLayer.innerHTML = ''
    if (!this.layers.saved || !this.savedList.length) return
    for (const item of this.savedList) {
      const point = this._projectScreen(item)
      if (!point) continue
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('class', 'saved-marker')
      g.setAttribute('transform', `translate(${point.x.toFixed(1)},${point.y.toFixed(1)})`)
      g.innerHTML = `<g class="saved-inner"><circle class="saved-bg" r="11"/><text class="saved-glyph" y="0.5">♡</text></g>`
      g.setAttribute('role', 'button')
      g.setAttribute('aria-label', `收藏地点 ${item.name}`)
      g.addEventListener('click', e => {
        e.stopPropagation()
        this.opts.onCandidateClick?.(item.poiId)
      })
      this.savedLayer.appendChild(g)
    }
  }

  _applyHighlight() {
    this.markersLayer.querySelectorAll<SVGGElement>('.marker').forEach(marker => {
      const id = marker.dataset.stopId || ''
      const active = this.highlightIds.size > 0
      const hit = active && this.highlightIds.has(id)
      marker.classList.toggle('dimmed', active && !hit)
      marker.classList.toggle('highlight-hit', hit)
    })
  }

  setHighlight(poiIds: string[]) {
    this.highlightIds = new Set(poiIds.filter(Boolean))
    this._applyHighlight()
    this._renderCandidates()
  }

  setCandidates(list: CandidatePlace[]) {
    this.candidates = list.filter(item => item.lat != null && item.lng != null)
    this._renderCandidates()
  }

  clearCandidates() {
    this.candidates = []
    this.candidateLayer.innerHTML = ''
  }

  setSaved(list: SavedPlace[]) {
    this.savedList = list
    this._renderSaved()
  }

  setLayerVisibility(layers: MapLayers) {
    this.layers = { ...layers }
    this.markersLayer.style.display = layers.trip ? '' : 'none'
    this.routesLayer.style.display = layers.trip ? '' : 'none'
    this._renderCandidates()
    this._renderSaved()
  }

  highlightLeg(fromStopId: string, toStopId: string) {
    this.routesLayer.querySelectorAll<SVGGElement>('.segment').forEach(seg => {
      const hit = seg.dataset.from === fromStopId && seg.dataset.to === toStopId
      seg.classList.toggle('route-focus', hit)
      seg.classList.toggle('route-dimmed', !hit)
    })
  }

  clearLegHighlight() {
    this.routesLayer.querySelectorAll<SVGGElement>('.segment').forEach(seg => {
      seg.classList.remove('route-focus', 'route-dimmed')
    })
  }

  _locatePlace(poiId: string): { lat: number; lng: number } | null {
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
    const rect = this.container.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const x = (rect.width / 2 - this.tx) / this.zoom
    const y = (rect.height / 2 - this.ty) / this.zoom
    return { lng: W.lng0 + x / W.scale, lat: W.lat0 - y / (W.scale * W.latStretch) }
  }

  focusPlace(poiId: string, opts: { zoom?: number } = {}) {
    const place = this._locatePlace(poiId)
    if (!place) return
    const point = project(place.lng, place.lat)
    const rect = this.container.getBoundingClientRect()
    const inset = Math.min(this.rightInset, rect.width * 0.52)
    const bottom = Math.min(this.bottomInset, rect.height * 0.7)
    const availableWidth = Math.max(rect.width - inset, 200)
    const availableHeight = Math.max(rect.height - bottom, 180)
    // SVG 画布没有真实缩放级别：按「街道级」的比例近似 zoom 14
    const target = opts.zoom ? Math.min(2.6, Math.max(0.6, opts.zoom / 9)) : 1.7
    this.zoom = Math.max(this.zoom, target)
    this.tx = availableWidth / 2 - point.x * this.zoom
    this.ty = availableHeight / 2 - point.y * this.zoom
    this._applyTransform()
  }

  _renderWaypoint(w: { name: string; lng: number; lat: number; dayIndex: number }) {
    const p = project(w.lng, w.lat)
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'waypoint')
    g.dataset.day = String(w.dayIndex)
    g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`)
    g.innerHTML = `<g class="waypoint-inner"><g class="waypoint-dot"><circle r="5"/></g><text class="waypoint-label" y="16">${esc(w.name)}</text></g>`
    this.markersLayer.appendChild(g)
  }

  applyDayFilter(day: number | 'all') {
    this.selectedDay = day
    this._applyDayVisibility()
    if (day !== 'all') this.fitView(day)
  }

  /** 仅切换可见性（几何更新后重绘路线时用，避免重新 fit 抢视野）。 */
  _applyDayVisibility() {
    const day = this.selectedDay
    const all = day === 'all'
    // 严格过滤：非当天的元素 display:none，而不是仅降低透明度。
    this.markersLayer.querySelectorAll<SVGGElement>('.marker').forEach(m => {
      const on = all || Number(m.dataset.day) === day
      m.style.display = on ? '' : 'none'
      m.style.opacity = '1'
    })
    this.markersLayer.querySelectorAll<SVGGElement>('.waypoint').forEach(m => {
      const on = all || Number(m.dataset.day) === day
      m.style.display = on ? '' : 'none'
      m.style.opacity = '1'
    })
    this.routesLayer.querySelectorAll<SVGGElement>('.segment').forEach(s => {
      const on = all || Number(s.dataset.day) === day
      s.style.display = on ? '' : 'none'
    })
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
    this._rerenderRoutes()
  }

  _rerenderRoutes() {
    this.routesLayer.innerHTML = ''
    this.segments = []
    const days = [...new Set(this.stops.map(s => s.dayIndex))]
    for (const dayIndex of days) this._renderDayRoutes(dayIndex)
    this._applyDayVisibility()
    this._applyConstantScreenSize()
    this._applyRouteLabelVisibility()
  }

  _applyRouteLabelVisibility() {
    this.routesLayer.querySelectorAll<SVGGElement>('.route-label').forEach(el => {
      el.style.display = this.zoom >= 1.15 ? '' : 'none'
    })
  }

  fitView(day: number | 'all' | null) {
    let pts: [number, number][]
    if (day === 'all' || day == null) pts = this.stops.map(s => [s.poi.lng || 0, s.poi.lat || 0])
    else pts = this.stops.filter(s => s.dayIndex === day).map(s => [s.poi.lng || 0, s.poi.lat || 0])
    if (!pts.length) return
    const proj = pts.map(p => project(p[0], p[1]))
    const minX = Math.min(...proj.map(p => p.x))
    const maxX = Math.max(...proj.map(p => p.x))
    const minY = Math.min(...proj.map(p => p.y))
    const maxY = Math.max(...proj.map(p => p.y))
    const rect = this.container.getBoundingClientRect()
    const padX = 96
    const padTop = 150
    const padBottom = 96
    const inset = Math.min(this.rightInset, rect.width * 0.52)
    const availableWidth = Math.max(rect.width - inset, 200)
    const bottomInset = Math.min(this.bottomInset, rect.height * 0.7)
    const availableHeight = Math.max(rect.height - bottomInset, 240)
    const zx = (availableWidth - padX * 2) / Math.max(maxX - minX, 1)
    const zy = (availableHeight - padTop - padBottom) / Math.max(maxY - minY, 1)
    this.zoom = Math.min(Math.max(Math.min(zx, zy), 0.4), 2.2)
    this.tx = availableWidth / 2 - ((minX + maxX) / 2) * this.zoom
    this.ty = padTop + (availableHeight - padTop - padBottom) / 2 - ((minY + maxY) / 2) * this.zoom
    this._applyTransform()
  }

  setRightInset(px: number) {
    this.rightInset = Math.max(0, px)
  }

  setBottomInset(px: number) {
    this.bottomInset = Math.max(0, px)
  }

  zoomBy(f: number) {
    const rect = this.container.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    const nz = Math.min(Math.max(this.zoom * f, 0.3), 5)
    this.tx = cx - (cx - this.tx) * (nz / this.zoom)
    this.ty = cy - (cy - this.ty) * (nz / this.zoom)
    this.zoom = nz
    this._applyTransform()
  }

  screenPos(stopId: string) {
    const s = this.stops.find(x => x.stopId === stopId)
    if (!s) return null
    const p = project(s.poi.lng || 0, s.poi.lat || 0)
    return { x: p.x * this.zoom + this.tx, y: p.y * this.zoom + this.ty }
  }

  centerOn(stopId: string) {
    const s = this.stops.find(x => x.stopId === stopId)
    if (!s) return
    const p = project(s.poi.lng || 0, s.poi.lat || 0)
    const rect = this.container.getBoundingClientRect()
    const inset = Math.min(this.rightInset, rect.width * 0.52)
    const availableWidth = Math.max(rect.width - inset, 200)
    const bottom = Math.min(this.bottomInset, rect.height * 0.7)
    const availableHeight = Math.max(rect.height - bottom, 180)
    this.zoom = Math.max(this.zoom, 1.1)
    this.tx = availableWidth / 2 - p.x * this.zoom
    this.ty = availableHeight / 2 - p.y * this.zoom
    this._applyTransform()
  }

  selectStop(stopId: string | null, fromMap = false) {
    this.markersLayer.querySelectorAll('.marker.selected').forEach(m => m.classList.remove('selected'))
    this.selectedStop = stopId
    if (stopId) {
      const m = this.markersLayer.querySelector(`.marker[data-stop-id="${CSS.escape(stopId)}"]`)
      m?.classList.add('selected')
    }
    if (fromMap && stopId) this.opts.onMarkerClick?.(stopId)
  }

  clearSelection() {
    this.markersLayer.querySelectorAll('.marker.selected').forEach(m => m.classList.remove('selected'))
    this.selectedStop = null
  }

  /** Incremental update after a plan_patch: never clears the whole map. */
  syncTrip(trip: Trip, changedDays: number[] = [], diff: DiffEntry[] = []) {
    const previous = new Map(this.stops.map(s => [s.stopId, s]))
    const nextStops: MapStop[] = []
    const daysToRebuild = new Set(changedDays)
    for (const day of trip.days) {
      for (const stop of day.stops) {
        nextStops.push({ ...stop, dayIndex: day.dayIndex })
      }
    }
    const nextIds = new Set(nextStops.map(s => s.stopId))
    for (const [id, old] of previous) {
      if (!nextIds.has(id)) {
        daysToRebuild.add(old.dayIndex)
        this.markersLayer.querySelector(`.marker[data-stop-id="${CSS.escape(id)}"]`)?.remove()
        this.segments = this.segments.filter(sg => {
          if (sg.from === id || sg.to === id) {
            sg.g.remove()
            return false
          }
          return true
        })
      }
    }
    for (const stop of nextStops) {
      const old = previous.get(stop.stopId)
      if (!old) {
        daysToRebuild.add(stop.dayIndex)
        this._renderMarker(stop)
      } else if (old.dayIndex !== stop.dayIndex || old.seq !== stop.seq) {
        daysToRebuild.add(old.dayIndex)
        daysToRebuild.add(stop.dayIndex)
        this.markersLayer.querySelector(`.marker[data-stop-id="${CSS.escape(stop.stopId)}"]`)?.remove()
        this._renderMarker(stop)
      } else {
        const el = this.markersLayer.querySelector<SVGGElement>(`.marker[data-stop-id="${CSS.escape(stop.stopId)}"]`)
        if (el) {
          const p = project(stop.poi.lng || 0, stop.poi.lat || 0)
          el.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`)
          const nameEl = el.querySelector('.marker-name')
          if (nameEl) nameEl.textContent = shortName(stop.poi.name)
        }
      }
    }
    this.stops = nextStops
    this.waypoints = []
    for (const day of trip.days) {
      for (const stop of day.stops) {
        for (const act of stop.activities) {
          const td = act.transitDetail
          if (td && td.mode === 'self_drive') {
            for (const wp of (td as SelfDriveDetail).waypointsPoi || []) {
              const name = typeof wp === 'string' ? wp : wp.name
              const known = WAYPOINT_COORDS.find(w => name.includes(w.name) || w.name.includes(name))
              if (known) this.waypoints.push({ ...known, dayIndex: day.dayIndex })
              else if (typeof wp !== 'string' && wp.lng != null && wp.lat != null)
                this.waypoints.push({ name, lng: wp.lng, lat: wp.lat, dayIndex: day.dayIndex })
            }
          }
        }
      }
    }
    this.markersLayer.querySelectorAll('.waypoint').forEach(el => el.remove())
    for (const w of this.waypoints) this._renderWaypoint(w)

    for (const dayIndex of daysToRebuild) this._rebuildDayRoutes(dayIndex)
    this._applyHighlight()
    this._renderCandidates()
    this._renderSaved()
    for (const entry of diff) {
      if (entry.stopId && entry.label) this.addDiffTag(entry.stopId, entry.label)
      if (entry.activityId) {
        const stop = this.stops.find(s => s.activities.some(a => a.activityId === entry.activityId))
        if (stop) {
          this.pulseMarker(stop.stopId)
          if (entry.label) this.addDiffTag(stop.stopId, entry.label)
        }
      }
    }
    for (const id of new Set(diff.flatMap(d => (d.stopId ? [d.stopId] : [])))) {
      this.pulseMarker(id)
    }
    if (this.selectedDay !== 'all') this.applyDayFilter(this.selectedDay)
  }

  applyPatch(patch: {
    removeStopIds?: string[]
    updateStops?: MapStop[]
    diffTags?: Record<string, string>
    flashSegments?: [string, string][]
  }) {
    for (const id of patch.removeStopIds || []) {
      this.markersLayer.querySelector(`.marker[data-stop-id="${CSS.escape(id)}"]`)?.remove()
      this.stops = this.stops.filter(s => s.stopId !== id)
      this.segments = this.segments.filter(sg => {
        if (sg.from === id || sg.to === id) {
          sg.g.remove()
          return false
        }
        return true
      })
    }
    for (const stop of patch.updateStops || []) {
      if (!this.stops.find(s => s.stopId === stop.stopId)) {
        this.stops.push(stop)
        this._renderMarker(stop)
      }
      this.pulseMarker(stop.stopId)
    }
    for (const [from, to] of patch.flashSegments || []) {
      const sg = this.segments.find(s => s.from === from && s.to === to)
      if (sg) {
        const path = sg.g.querySelector('.route-path')
        path?.classList.remove('route-flash')
        void (path as Element)?.getBoundingClientRect()
        path?.classList.add('route-flash')
        setTimeout(() => path?.classList.remove('route-flash'), 1700)
      }
    }
    for (const [stopId, text] of Object.entries(patch.diffTags || {})) this.addDiffTag(stopId, text)
  }

  pulseMarker(stopId: string) {
    const m = this.markersLayer.querySelector(`.marker[data-stop-id="${CSS.escape(stopId)}"]`)
    if (!m) return
    m.querySelectorAll('.marker-pulse').forEach(x => x.remove())
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    ring.setAttribute('class', 'marker-pulse')
    ring.setAttribute('r', '13')
    ring.setAttribute('fill', 'none')
    ring.setAttribute('stroke', 'var(--accent)')
    ring.setAttribute('stroke-width', '3')
    const inner = m.querySelector('.marker-inner') as SVGGElement | null
    if (inner) inner.insertBefore(ring, inner.firstChild)
    else m.insertBefore(ring, m.firstChild)
    ring.setAttribute('r', (13 / this.zoom).toFixed(2))
    setTimeout(() => ring.remove(), 1300)
  }

  addDiffTag(stopId: string, text: string) {
    const m = this.markersLayer.querySelector(`.marker[data-stop-id="${CSS.escape(stopId)}"]`)
    if (!m) return
    m.querySelectorAll('.marker-diff-tag').forEach(x => x.remove())
    const w = text.length * 6.2 + 14
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'marker-diff-tag')
    g.innerHTML = `<rect x="${(-w / 2).toFixed(1)}" y="-40" width="${w.toFixed(1)}" height="17" rx="4"/>
      <text x="0" y="-31.5">${esc(text)}</text>
      <path d="M-4,-23 L4,-23 L0,-18 Z" fill="var(--accent)"/>`
    const inner = m.querySelector('.marker-inner') as SVGGElement | null
    ;(inner || m).appendChild(g)
    this.diffTags[stopId] = text
  }

  _bindGestures() {
    const c = this.container
    c.addEventListener('pointerdown', e => {
      if ((e.target as Element).closest('.marker, .route-hit, .trip-panel, .map-overlay')) return
      this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty }
      c.setPointerCapture(e.pointerId)
    })
    c.addEventListener('pointermove', e => {
      if (!this.drag) return
      this.tx = this.drag.tx + (e.clientX - this.drag.x)
      this.ty = this.drag.ty + (e.clientY - this.drag.y)
      this._applyTransform()
    })
    c.addEventListener('pointerup', () => {
      this.drag = null
    })
    c.addEventListener(
      'wheel',
      e => {
        e.preventDefault()
        this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
      },
      { passive: false },
    )
    c.addEventListener('click', e => {
      if (!(e.target as Element).closest('.marker, .trip-panel, .map-overlay, .route-hit')) {
        this.opts.onBlankClick?.()
      }
    })
  }

  destroy() {
    this.container.innerHTML = ''
  }
}

export function renderThumbSvg(points: [number, number][], dayColors: string[]): string {
  if (!points || points.length < 2) return ''
  const lngs = points.map(p => p[0])
  const lats = points.map(p => p[1])
  const minLng = Math.min(...lngs) - 0.6
  const maxLng = Math.max(...lngs) + 0.6
  const minLat = Math.min(...lats) - 0.4
  const maxLat = Math.max(...lats) + 0.4
  const W2 = 320
  const H2 = 150
  const px = (lng: number) => ((lng - minLng) / (maxLng - minLng)) * W2
  const py = (lat: number) => H2 - ((lat - minLat) / (maxLat - minLat)) * H2
  let html = `<rect width="${W2}" height="${H2}" fill="#EDF1F4"/>`
  html += `<path d="M0,${H2 * 0.62} Q${W2 * 0.3},${H2 * 0.5} ${W2 * 0.55},${H2 * 0.66} T${W2},${H2 * 0.58} V${H2} H0 Z" fill="#E4EAE3"/>`
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(' ')
  html += `<path d="${d}" fill="none" stroke="#1D6F5C" stroke-width="2" stroke-dasharray="7 4" stroke-linecap="round" opacity=".8"/>`
  points.forEach((p, i) => {
    const color = dayColors[Math.min(i, dayColors.length - 1)] || '#1D6F5C'
    html += `<circle cx="${px(p[0]).toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="4.5" fill="${color}" stroke="#fff" stroke-width="1.6"/>`
  })
  return html
}

export function tripRoutePoints(trip: Trip): [number, number][] {
  const out: [number, number][] = []
  for (const day of trip.days) {
    for (const stop of day.stops) {
      if (stop.poi.lng != null && stop.poi.lat != null) out.push([stop.poi.lng, stop.poi.lat])
    }
  }
  return out
}
