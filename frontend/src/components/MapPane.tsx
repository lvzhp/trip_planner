import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MapCanvas } from '../map/MapCanvas'
import type { MapController } from '../map/controller'
import { useAppStore } from '../stores/appStore'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { usePlaceStore } from '../stores/placeStore'
import { useMediaQuery } from '../lib/useMediaQuery'
import { toast } from '../lib/toast'
import { fmtDate } from '../lib/format'
import { Icon } from '../lib/icons'
import { isTouchSurface } from '../lib/placeMeta'
import { usePlaceActions } from '../lib/placeActions'
import type { CandidatePlace } from '../types'
import { onClearLegHighlight, onFitMapView, onFocusPlace, onHighlightLeg } from '../lib/mapBridge'
import { MapToolbar } from './MapToolbar'
import { LegInfoBar } from './DistanceRow'
import type { Day, DiffEntry, Trip } from '../types'

interface Props {
  mapRef: React.MutableRefObject<MapController | null>
  onMarkerClick: (stopId: string, dayIndex: number) => void
  onBlankClick: () => void
  children?: React.ReactNode
}

export function MapPane({ mapRef, onMarkerClick, onBlankClick, children }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const initializedFor = useRef<string | null>(null)
  const lastDiffNonce = useRef(0)
  const lastVersion = useRef<number | null>(null)
  const [ready, setReady] = useState(0)
  const placeActions = usePlaceActions()
  const placeActionsRef = useRef(placeActions)
  placeActionsRef.current = placeActions
  const routeLegs = useTripStore(s => s.routeLegs)
  const amapWebConfigured = Boolean(useAppStore(s => s.config?.amapWebConfigured))
  const geometryTriedFor = useRef<string | null>(null)
  const geometryAttempts = useRef(0)
  const highlight = useUiStore(s => s.highlight)
  const candidates = useUiStore(s => s.candidates)
  const layers = useUiStore(s => s.layers)
  const savedPlaces = usePlaceStore(s => s.saved)
  const loadSaved = usePlaceStore(s => s.load)
  const itineraryOpen = useUiStore(s => s.itineraryOpen)
  const itineraryWidth = useUiStore(s => s.itineraryWidth)
  const config = useAppStore(s => s.config)
  const trip = useTripStore(s => s.trip)
  const tripId = useTripStore(s => s.tripId)
  const diffTags = useTripStore(s => s.diffTags)
  const changedDays = useTripStore(s => s.changedDays)
  const diffNonce = useTripStore(s => s.diffNonce)
  const activeDay = useUiStore(s => s.activeDay)
  const mapDay = useUiStore(s => s.mapDay)
  const selectedStopId = useUiStore(s => s.selectedStopId)
  const panelCollapsed = useUiStore(s => s.panelCollapsed)
  const mobileSheet = useUiStore(s => s.mobileSheet)
  const mobile = useMediaQuery('(max-width: 767px)')
  // 高德中国区没有境外底图（例如日本行程会是一张空白图）：整趟都在境外时用 OSM 兜底
  const locatedStops = (trip?.days || []).flatMap(day => day.stops).filter(stop => stop.poi.lng != null && stop.poi.lat != null)
  const outsideAmapCoverage =
    locatedStops.length > 0 &&
    locatedStops.every(stop => {
      const lng = stop.poi.lng as number
      const lat = stop.poi.lat as number
      return lng < 73 || lng > 135.1 || lat < 18 || lat > 54
    })

  // create the map adapter once per trip/config key
  useEffect(() => {
    if (!hostRef.current) return
    let disposed = false
    let controller: MapController | null = null
    const host = hostRef.current

    const markerClick = (stopId: string) => {
      const found = findStop(useTripStore.getState().trip, stopId)
      if (found) onMarkerClick(stopId, found.day.dayIndex)
    }

    /** 候选点 / 收藏点点击：打开浮卡；不改变行程。 */
    const candidateClick = (poiId: string) => {
      const ui = useUiStore.getState()
      const candidate =
        ui.candidates.find(item => item.poiId === poiId) ||
        usePlaceStore.getState().saved.find(item => item.poiId === poiId)
      const segment = candidate
        ? {
            type: 'place' as const,
            poiId,
            stopId: (candidate as any).stopId ?? null,
            name: candidate.name,
            fullName: candidate.name,
            category: (candidate as any).category || ('place' as const),
            added: !!(candidate as any).added,
            hasCoords: candidate.lat != null && candidate.lng != null,
            city: candidate.city ?? null,
            address: candidate.address ?? null,
            lat: candidate.lat ?? null,
            lng: candidate.lng ?? null,
            dayIndex: (candidate as any).dayIndex ?? null,
          }
        : null
      ui.openPlace(poiId, {
        mode: isTouchSurface() ? 'sheet' : 'popover',
        origin: 'candidate',
        segment,
        anchor: null,
      })
    }

    /** 候选点上的小 ＋：一键加入当前天（3 次点击内完成加地点）。 */
    const candidateAdd = (poiId: string) => {
      const ui = useUiStore.getState()
      const candidate =
        ui.candidates.find(item => item.poiId === poiId) ||
        usePlaceStore.getState().saved.find(item => item.poiId === poiId)
      if (!candidate) return
      const normalized: CandidatePlace = {
        poiId: candidate.poiId,
        name: candidate.name,
        category: (candidate as CandidatePlace).category || 'place',
        lat: candidate.lat ?? null,
        lng: candidate.lng ?? null,
        city: candidate.city ?? null,
        address: candidate.address ?? null,
        source: (candidate as CandidatePlace).source || 'saved',
      }
      void placeActionsRef.current.addCandidate(normalized)
    }

    const makeLeaflet = async (): Promise<MapController | null> => {
      try {
        const { LeafletCanvas } = await import('../map/LeafletCanvas')
        return new LeafletCanvas(host, {
          onMarkerClick: markerClick,
          onBlankClick: blankClick,
          onCandidateClick: candidateClick,
          onCandidateAdd: candidateAdd,
        })
      } catch (err) {
        console.warn('Leaflet/OSM load failed', err)
        return null
      }
    }
    const blankClick = () => {
      useUiStore.getState().closePlace()
      onBlankClick()
    }

    const makeSvg = () =>
      new MapCanvas(host, {
        interactive: true,
        onMarkerClick: markerClick,
        onBlankClick: blankClick,
        onCandidateClick: candidateClick,
        onCandidateAdd: candidateAdd,
      })

    const create = async () => {
      let provider = config?.mapProvider || (config?.amapJsKey ? 'amap' : 'leaflet')
      if (outsideAmapCoverage && provider === 'amap') {
        provider = 'leaflet'
        toast('该行程不在高德中国区覆盖范围，已切换到 OpenStreetMap 底图', 'info')
      }
      const key = config?.amapJsKey
      if (provider === 'amap' && key) {
        try {
          const { AmapCanvas } = await import('../map/AmapCanvas')
          const amap = new AmapCanvas(host, {
            key,
            securityCode: config?.amapJsSecurityCode,
            onMarkerClick: markerClick,
            onBlankClick: blankClick,
            onCandidateClick: candidateClick,
            onCandidateAdd: candidateAdd,
          })
          await amap.ready
          if (disposed) {
            amap.destroy()
            return
          }
          controller = amap
        } catch (err) {
          console.warn('AMap load failed, falling back to Leaflet', err)
          toast('高德地图加载失败，已切换到 OpenStreetMap', 'info')
        }
      }
      if (!controller && (provider === 'leaflet' || provider === 'amap')) {
        controller = await makeLeaflet()
        if (!controller) toast('真实地图加载失败，已切换到离线画布', 'info')
      }
      if (!controller) {
        controller = makeSvg()
      }
      if (disposed) {
        controller.destroy()
        return
      }
      controller.setRightInset(!useUiStore.getState().panelCollapsed && window.innerWidth > 767 ? 384 : 0)
      controller.setBottomInset(0)
      mapRef.current = controller
      initializedFor.current = null
      setReady(v => v + 1)
    }
    void create()
    return () => {
      disposed = true
      if (mapRef.current === controller) mapRef.current = null
      controller?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, config?.amapJsKey, config?.mapProvider, outsideAmapCoverage])

  // initial data / incremental patches
  useEffect(() => {
    const map = mapRef.current
    if (!map || !trip) return
    if (initializedFor.current !== trip.tripId) {
      map.setTrip(trip)
      map.applyDayFilter('all')
      initializedFor.current = trip.tripId
      lastDiffNonce.current = diffNonce
      lastVersion.current = trip.version
      const t = window.setTimeout(() => map.fitView('all'), 80)
      return () => window.clearTimeout(t)
    }
    if (diffNonce !== lastDiffNonce.current) {
      lastDiffNonce.current = diffNonce
      lastVersion.current = trip.version
      const diff: DiffEntry[] = Object.entries(diffTags).map(([stopId, label]) => ({
        stopId,
        label,
        field: 'stop',
        op: 'mod',
      }))
      map.syncTrip(trip, changedDays, diff)
    } else if (lastVersion.current !== trip.version) {
      // restore / full replacement (no plan_patch event)
      lastVersion.current = trip.version
      map.setTrip(trip)
      map.applyDayFilter(mapDay)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, diffNonce, ready])

  // 真实道路几何（有 polyline 就沿道路画，没有才退回两点示意）
  useEffect(() => {
    if (!ready) return
    mapRef.current?.setRouteLegs(routeLegs)
  }, [routeLegs, ready, mapRef])

  // 首次加载后异步补齐几何（后端有 7 天缓存；没有高德 Web key 时跳过）
  useEffect(() => {
    if (!ready || !tripId || !amapWebConfigured) return
    const needsGeometry = routeLegs.some(
      leg => !leg.polyline && (leg.mode === 'walk' || leg.mode === 'drive' || leg.mode === 'transit'),
    )
    if (!needsGeometry) return
    if (geometryTriedFor.current !== tripId) {
      geometryTriedFor.current = tripId
      geometryAttempts.current = 0
    }
    // 高德有 QPS 限制：第一次补齐后若仍有缺口，依次隔 5s / 15s 再补
    if (geometryAttempts.current >= 3) return
    const attempt = geometryAttempts.current
    geometryAttempts.current += 1
    const delays = [0, 5000, 15000]
    const timer = window.setTimeout(() => {
      void useTripStore.getState().refreshLegs()
    }, delays[attempt] ?? 15000)
    return () => window.clearTimeout(timer)
  }, [ready, tripId, amapWebConfigured, routeLegs])

  // 候选层 / 高亮 / 收藏层（不重挂地图，只更新覆盖物）
  useEffect(() => {
    if (!ready) return
    const map = mapRef.current
    // 已加入行程的候选点由行程层渲染编号 marker，不再重复出现在候选层
    map?.setCandidates(candidates.filter(item => !item.added))
  }, [candidates, ready, mapRef])

  useEffect(() => {
    if (!ready) return
    // 「本轮」是整趟行程的概念：按天过滤时不压暗当天所有点，否则整屏都是灰的
    mapRef.current?.setHighlight(mapDay === 'all' ? highlight.poiIds : [])
  }, [highlight.poiIds, mapDay, ready, mapRef])

  useEffect(() => {
    if (!ready) return
    mapRef.current?.setSaved(savedPlaces)
  }, [savedPlaces, ready, mapRef])

  useEffect(() => {
    if (!ready) return
    mapRef.current?.setLayerVisibility(layers)
  }, [layers, ready, mapRef])

  useEffect(() => {
    void loadSaved()
  }, [loadSaved])

  // 新 turn 的高亮集合：用户 5s 内刚拖过地图就不抢视野（§3.2）
  useEffect(() => {
    if (!ready || !highlight.turnId) return
    const lastPan = useUiStore.getState().lastUserPanAt
    if (Date.now() - lastPan < 5000) return
    const timer = window.setTimeout(() => mapRef.current?.fitView(useUiStore.getState().mapDay), 260)
    return () => window.clearTimeout(timer)
  }, [highlight.turnId, ready])

  // 地图桥：chip / 候选点 / 距离行的事件
  useEffect(
    () =>
      onFocusPlace(({ poiId, zoom }) => {
        mapRef.current?.selectStop(poiId)
        mapRef.current?.focusPlace(poiId, { zoom })
      }),
    [mapRef],
  )
  useEffect(
    () =>
      onHighlightLeg(({ fromStopId, toStopId }) => {
        mapRef.current?.highlightLeg(fromStopId, toStopId)
      }),
    [mapRef],
  )
  useEffect(() => onClearLegHighlight(() => mapRef.current?.clearLegHighlight()), [mapRef])
  useEffect(
    () => onFitMapView(() => mapRef.current?.fitView(useUiStore.getState().mapDay)),
    [mapRef],
  )

  // 用户手势：记录时间戳，避免新 turn 抢视野
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const mark = () => useUiStore.getState().noteUserPan()
    host.addEventListener('pointerdown', mark)
    host.addEventListener('wheel', mark, { passive: true })
    host.addEventListener('touchstart', mark, { passive: true })
    return () => {
      host.removeEventListener('pointerdown', mark)
      host.removeEventListener('wheel', mark)
      host.removeEventListener('touchstart', mark)
    }
  }, [])

  // day filter + panel inset (the card panel floats over the map)
  useEffect(() => {
    if (!ready) return
    const map = mapRef.current
    map?.setRightInset(!panelCollapsed && !mobile ? 384 : 0)
    const h = hostRef.current?.clientHeight || 0
    const bottom = !mobile ? 0 : mobileSheet === 0 ? 64 : mobileSheet === 1 ? Math.round(h * 0.42) : Math.round(h * 0.78)
    map?.setBottomInset(bottom)
    map?.applyDayFilter(mapDay)
    // 等抽屉高度落定后再 fit：StrictMode 下首次 effect 的 80ms 定时器会被 cleanup 掉
    const t = window.setTimeout(() => mapRef.current?.fitView(mapDay), 140)
    return () => window.clearTimeout(t)
  }, [mapDay, ready, panelCollapsed, mobile, mobileSheet, mapRef])

  // 行程抽屉打开时只改右内边距，不重新 fit（关闭后地图保持原视野）
  useEffect(() => {
    if (!ready || mobile) return
    const map = mapRef.current
    const inset = itineraryOpen ? itineraryWidth : !panelCollapsed ? 384 : 0
    map?.setRightInset(inset)
  }, [itineraryOpen, itineraryWidth, panelCollapsed, mobile, ready, mapRef])

  // selection (single source of truth)
  useEffect(() => {
    mapRef.current?.selectStop(selectedStopId)
  }, [selectedStopId, mapRef])

  // keep view fitting on container resize (splitter drag / panel collapse)
  useEffect(() => {
    if (!hostRef.current || !mapRef.current) return
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => mapRef.current?.fitView(mapDay))
    })
    observer.observe(hostRef.current)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [mapDay, remapTrigger(panelCollapsed)])

  const day = trip?.days.find(d => d.dayIndex === activeDay)

  return (
    <section className="map-pane" aria-label="行程地图">
      <div id="map-canvas" ref={hostRef} />

      <div className="map-overlay map-controls-tr">
        <div className="map-ctrl-group">
          <button type="button" onClick={() => mapRef.current?.zoomBy(1.25)} aria-label="放大" title="放大">
            <Icon name="plus" />
          </button>
          <button type="button" onClick={() => mapRef.current?.zoomBy(1 / 1.25)} aria-label="缩小" title="缩小">
            <Icon name="minus" />
          </button>
          <button type="button" onClick={() => mapRef.current?.fitView(mapDay)} aria-label="适应视野" title="适应视野">
            <Icon name="maximize" />
          </button>
          <button
            type="button"
            onClick={() => {
              useUiStore.getState().setActiveDay(activeDay, false)
              useUiStore.setState({ mapDay: 'all' })
              mapRef.current?.applyDayFilter('all')
            }}
            aria-label="显示全部"
            title="显示全部"
          >
            <Icon name="layers" />
          </button>
        </div>
      </div>

      <div className="map-overlay map-legend" aria-label="图例">
        <div className="legend-title">图例</div>
        <div className="legend-row">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8" fill="var(--bg)" stroke="var(--border-strong)" strokeWidth="1.5" />
            <text x="12" y="13" textAnchor="middle" fontSize="9" fill="var(--text-muted)">🍴</text>
          </svg>
          <span>候选</span>
        </div>
        <div className="legend-row">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="var(--day-1)" stroke="#fff" strokeWidth="2" />
            <text x="12" y="13" textAnchor="middle" fontSize="9" fill="#fff">1</text>
          </svg>
          <span>行程</span>
        </div>
        <div className="legend-row">
          <svg width="30" height="10" aria-hidden="true"><line x1="2" y1="5" x2="28" y2="5" stroke="var(--line-drive)" strokeWidth="3" strokeLinecap="round" /></svg>
          <span>路线</span>
        </div>
      </div>

      {day && (
        <div className="map-overlay map-daycard" style={{ ['--day-color' as string]: `var(--day-${((day.dayIndex - 1) % 12) + 1})` } as React.CSSProperties}>
          <span className="day-swatch" />
          <div>
            <div className="dc-title">
              Day {day.dayIndex} · {fmtDate(day.date)}
            </div>
            <div className="dc-sub">{dayRouteLabel(day)}</div>
          </div>
          <span className="dc-nav">
            <button
              type="button"
              aria-label="前一天"
              onClick={() => {
                const n = day.dayIndex - 1
                if (n >= 1) useUiStore.getState().setActiveDay(n)
              }}
            >
              <Icon name="chevronLeft" />
            </button>
            <button
              type="button"
              aria-label="后一天"
              onClick={() => {
                const n = day.dayIndex + 1
                if (trip && n <= trip.days.length) useUiStore.getState().setActiveDay(n)
              }}
            >
              <Icon name="chevronRight" />
            </button>
          </span>
        </div>
      )}

      {!trip?.days.length && (
        <div className="map-skeleton" aria-label="地图准备中" style={{ right: !panelCollapsed && !mobile ? 384 : 0 }}>
          <div className="map-skeleton-card">
            <div className="sk-title">地图准备中</div>
            <div className="sk-sub">先回答几个问题，AI 会检索地点并绘制路线</div>
            <div className="sk-bars">
              <i /><i /><i />
            </div>
          </div>
        </div>
      )}

      <MapToolbar viewCenter={() => mapRef.current?.viewCenter() ?? null} />

      <LegInfoBar />
      {children}
    </section>
  )
}

function remapTrigger(collapsed: boolean) {
  return collapsed ? 'collapsed' : 'open'
}

function findStop(trip: Trip | null, stopId: string): { day: Day; stop: Trip['days'][number]['stops'][number] } | null {
  if (!trip) return null
  for (const day of trip.days) {
    for (const stop of day.stops) if (stop.stopId === stopId) return { day, stop }
  }
  return null
}

function dayRouteLabel(day: Day): string {
  const names = day.stops.map(s => s.poi.name.split(' · ')[0])
  if (!names.length) return '尚未安排'
  return names.length > 2 ? `${names[0]} → … → ${names[names.length - 1]}` : names.join(' → ')
}
