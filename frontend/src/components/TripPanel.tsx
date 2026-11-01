import { useEffect, useMemo, useRef, useState } from 'react'
import type { Conflict, Day, DayDerived, Stop } from '../types'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { conflictTypeLabel, Icon } from '../lib/icons'
import { dayBudget, fmtDate } from '../lib/format'
import { ActivityCard } from './ActivityCard'
import { DistanceRow } from './DistanceRow'
import { hapticTap } from '../platform/shell'
import { StopDetail } from './StopDetail'

interface Props {
  mobile: boolean
  /** 移动端从「改这里 / 改作息」跳转到对话页 */
  onStartChat?: () => void
  onEditStop: (stopId: string, dayIndex: number) => void
  onEditActivity: (stopId: string, activityId: string, dayIndex: number) => void
  onSelectCard: (stopId: string, activityId: string, dayIndex: number) => void
  onOpenCardDetail: (stopId: string, activityId: string, dayIndex: number) => void
  onConflictChoice: (conflict: Conflict, optionLabel: string) => void
  onOpenConflicts: () => void
  pendingDay?: number | null
}

export function TripPanel({
  mobile,
  onStartChat,
  onEditStop,
  onEditActivity,
  onSelectCard,
  onOpenCardDetail,
  onConflictChoice,
  onOpenConflicts,
  pendingDay,
}: Props) {
  const trip = useTripStore(s => s.trip)
  const derived = useTripStore(s => s.derived)
  const readonly = useTripStore(s => s.readonly)
  const activeDay = useUiStore(s => s.activeDay)
  const setActiveDay = useUiStore(s => s.setActiveDay)
  const selectedNonce = useUiStore(s => s.selectedNonce)
  const selectedStopId = useUiStore(s => s.selectedStopId)
  const selectedActivityId = useUiStore(s => s.selectedActivityId)
  const panelCollapsed = useUiStore(s => s.panelCollapsed)
  const mapDay = useUiStore(s => s.mapDay)
  const setMapDay = useUiStore(s => s.setMapDay)
  const mobileSheet = useUiStore(s => s.mobileSheet)
  const setMobileSheet = useUiStore(s => s.setMobileSheet)
  const detailStopId = useUiStore(s => s.detailStopId)
  const closeStopDetail = useUiStore(s => s.closeStopDetail)
  const addContextTag = useUiStore(s => s.addContextTag)
  const focusComposer = useUiStore(s => s.focusComposer)
  const setComposerPlaceholder = useUiStore(s => s.setComposerPlaceholder)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [sheetDrag, setSheetDrag] = useState(0)
  const sheetDragRef = useRef({ moved: false })

  /** 底部抽屉拖拽：拖动跟手，松手吸附到 0/1/2 档；轻点仍循环切档。 */
  const onSheetPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!mobile) return
    const startY = event.clientY
    const startLevel = mobileSheet
    const drag = sheetDragRef.current
    drag.moved = false
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      if (Math.abs(dy) > 6) drag.moved = true
      setSheetDrag(dy)
    }
    const up = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      setSheetDrag(0)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.setTimeout(() => { drag.moved = false }, 360)
      if (Math.abs(dy) < 36) return
      let next: 0 | 1 | 2 = startLevel
      if (startLevel === 0) next = dy < -150 ? 2 : dy < -40 ? 1 : 0
      else if (startLevel === 1) next = dy > 50 ? 0 : dy < -55 ? 2 : 1
      else next = dy > 110 ? 1 : 2
      if (next !== startLevel) {
        setMobileSheet(next)
        hapticTap('light')
      }
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onSheetClick = () => {
    if (sheetDragRef.current.moved) return
    // 轻点把手 = 在地图与半屏详情之间切换；三档仍可拖拽。
    setMobileSheet(mobileSheet === 0 ? 1 : 0)
  }

  const sheetDragStyle = mobile && sheetDrag !== 0
    ? {
        transform: mobileSheet === 0
          ? `translateY(calc(100% - 64px + ${sheetDrag}px))`
          : `translateY(${sheetDrag}px)`,
        transition: 'none',
      } as React.CSSProperties
    : undefined

  const day = trip?.days.find(d => d.dayIndex === activeDay) || trip?.days[0]
  const dayDerived = derived?.days.find(d => d.dayIndex === day?.dayIndex)
  const dayConflicts = useMemo(
    () => (derived?.conflicts || []).filter(c => c.dayIndex === day?.dayIndex),
    [derived, day?.dayIndex],
  )

  // 详情视图的定位/高亮（含从对话栏存根跳转过来的 scrollToSeq）
  useEffect(() => {
    if (!selectedNonce) return
    const host = scrollRef.current
    if (!host) return
    const id = window.setTimeout(() => {
      const selector = selectedActivityId
        ? `.act-card[data-activity-id="${CSS.escape(selectedActivityId)}"]`
        : `.act-card[data-stop-id="${CSS.escape(selectedStopId || '')}"]`
      const card = host.querySelector<HTMLElement>(selector)
      if (!card) return
      card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      card.classList.remove('flash-highlight')
      void card.offsetWidth
      card.classList.add('flash-highlight')
      window.setTimeout(() => card.classList.remove('flash-highlight'), 1300)
    }, 80)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNonce])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [activeDay])

  if (!trip) {
    return (
      <aside className="trip-panel" aria-label="行程卡片面板">
        <div className="panel-empty">
          <span className="spinner" />
          <span>正在加载行程…</span>
        </div>
      </aside>
    )
  }

  const switchDay = (dayIndex: number) => {
    setActiveDay(dayIndex)
  }

  const sheetClass = mobile
    ? mobileSheet === 0
      ? ' collapsed'
      : mobileSheet === 1
        ? ' half'
        : ' full'
    : panelCollapsed
      ? ' collapsed'
      : ''

  // ---- 详情模式（docs/07 §5）：面板只有 list / detail 两个模式 ----
  if (detailStopId) {
    const found = findStopInTrip(trip, detailStopId)
    if (found) {
      return (
        <aside className={`trip-panel${sheetClass}`} id="trip-panel" aria-label="地点详情">
          <StopDetail
            stop={found.stop}
            day={found.day}
            activityId={selectedActivityId}
            mobile={mobile}
            readonly={readonly}
            onClose={closeStopDetail}
            onEditStop={onEditStop}
            onEditActivity={activityId => onEditActivity(found.stop.stopId, activityId, found.day.dayIndex)}
          />
        </aside>
      )
    }
    // stop 已被删除（重规划）：退回列表
    closeStopDetail()
  }

  return (
    <aside
      className={`trip-panel${sheetClass}${sheetDrag !== 0 ? ' dragging' : ''}`}
      id="trip-panel"
      aria-label="行程卡片面板"
      style={sheetDragStyle}
    >
      <div
        className="sheet-handle"
        id="sheet-handle"
        role="button"
        tabIndex={0}
        aria-label="拖动或点击调整行程面板高度"
        onPointerDown={onSheetPointerDown}
        onClick={onSheetClick}
      >
        <span className="handle-bar" />
        <span className="handle-summary">
          <strong>Day {day?.dayIndex || 1}</strong> · {day?.theme || '暂无安排'} · {day?.stops.length || 0} 站 · v{trip.version}
        </span>
      </div>
      <>
          <div className="day-tabs" role="tablist" aria-label="按天切换" style={{ display: trip.days.length ? undefined : 'none' }}>
            <button
              type="button"
              role="tab"
              aria-selected={mapDay === 'all'}
              className={`day-tab all-tab${mapDay === 'all' ? ' active' : ''}`}
              onClick={() => setMapDay('all')}
            >
              <span className="dt-day">全部</span>
              <span className="dt-date">全程</span>
            </button>
            {trip.days.map(d => {
              const conf = (derived?.conflicts || []).filter(c => c.dayIndex === d.dayIndex)
              const hasErr = conf.some(c => c.severity === 'error')
              const hasWarn = conf.length > 0
              return (
                <button
                  key={d.dayIndex}
                  type="button"
                  className={`day-tab${mapDay === d.dayIndex ? ' active' : ''}`}
                  style={{ ['--day-color' as string]: `var(--day-${((d.dayIndex - 1) % 12) + 1})` } as React.CSSProperties}
                  onClick={() => switchDay(d.dayIndex)}
                  role="tab"
                  aria-selected={mapDay === d.dayIndex}
                >
                  <span className="dt-day">Day {d.dayIndex}</span>
                  <span className="dt-date">{fmtDate(d.date)}</span>
                  {hasErr ? <span className="conflict-dot" title="有错误" /> : hasWarn ? <span className="conflict-dot warning-only" title="有警告" /> : null}
                </button>
              )
            })}
          </div>
          <div className="panel-scroll" id="panel-scroll" ref={scrollRef}>
            {!trip.days.length && (
              <div className="panel-empty panel-empty-planning">
                <span className="spinner" />
                <strong>正在检索地点并生成行程…</strong>
                <span>工具调用在左侧时间线可见。地图与面板保持可交互，不会用整页遮罩挡住进度。</span>
                <div className="panel-skeleton-lines"><i /><i /><i /><i /></div>
              </div>
            )}
            {day && (
              <>
                <div className="day-head" style={{ ['--day-color' as string]: `var(--day-${((day.dayIndex - 1) % 12) + 1})` } as React.CSSProperties}>
                  <div className="day-head-top">
                    <span className="dh-swatch" />
                    <span className="dh-title" title={day.theme || undefined}>
                      Day {day.dayIndex} · {day.theme}
                    </span>
                    <span className="dh-date">{fmtDate(day.date)}</span>
                    {!readonly && (
                      <button
                        className="dh-edit-rhythm"
                        type="button"
                        onClick={() => {
                          addContextTag({ kind: 'rhythm', label: `Day ${day.dayIndex} 作息`, dayIndex: day.dayIndex })
                          setComposerPlaceholder('想说新的起床/休息时间？例如：明天 13:00 起、23:30 睡')
                          focusComposer()
                          onStartChat?.()
                        }}
                      >
                        <Icon name="clock" /> 改作息
                      </button>
                    )}
                  </div>
                  <div className="day-stats">
                    <div className="od-stat">
                      <span className="st-num">
                        {dayDerived?.window.firstStart || '—'}–{dayDerived?.window.lastEnd || '—'}
                      </span>
                      <span className="st-cap">
                        作息 {day.rhythm.wake} 起 / {day.rhythm.sleep} 休
                      </span>
                    </div>
                    <div className="od-stat">
                      <span className="st-num">{dayDerived?.loadHours || 0}h</span>
                      <span className="st-cap">活动负载</span>
                    </div>
                    <div className="od-stat">
                      <span className="st-num">{dayDerived?.window.transitHours || 0}h</span>
                      <span className="st-cap">交通</span>
                    </div>
                    <div className="od-stat">
                      <span className="st-num">¥{dayBudget(day).toLocaleString()}</span>
                      <span className="st-cap">当日预算</span>
                    </div>
                  </div>
                </div>
                <div className="day-cards" data-day={day.dayIndex}>
                  {dayConflicts
                    .filter(c => !c.activityId)
                    .map(c => (
                      <div
                        className={`conflict-item severity-${c.severity}`}
                        key={c.id || c.message}
                        style={{ cursor: 'pointer' }}
                        onClick={onOpenConflicts}
                      >
                        <div className="ci-head">
                          <span className="ci-type">
                            <Icon name={c.severity === 'error' ? 'xCircle' : 'warn'} /> {conflictTypeLabel[c.type] || c.type}
                          </span>
                          <span className="ci-day">Day {c.dayIndex}</span>
                        </div>
                        <div className="ci-msg">{c.message}</div>
                      </div>
                    ))}
                  <CardStream
                    day={day}
                    dayDerived={dayDerived}
                    readonly={readonly}
                    pendingDay={pendingDay}
                    transportMode={trip.constraints.transportMode}
                    onEditActivity={onEditActivity}
                    onSelectCard={onSelectCard}
                    onOpenCardDetail={onOpenCardDetail}
                    onConflictChoice={onConflictChoice}
                    onOpenConflicts={onOpenConflicts}
                  />
                  {!day.stops.length && (
                    <div className="panel-empty">
                      <Icon name="map" />
                      <span>这一天还没有安排。告诉我想去哪，或让我补排。</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </>
    </aside>
  )
}

/**
 * 卡片流：不再有独立的 stop 组头（docs/07 §3）。
 *
 * 每一张活动卡自己携带地点信息（名称 / 地址 / 导航 / 详情），卡片就是交互主体。
 * 位置仍属于 stop（同一 stop 下多个 activity 坐标相同），但入口从「组头」下移到卡片：
 *   - 点卡片 = 选中这张卡 + 地图定位；
 *   - 卡片内「详情」= 进入该 stop 的详情，并把这张卡作为概览高亮上下文；
 *   - 卡片内「改这里」= 挂具体 activity 的上下文，而不是整段 stop。
 */
function CardStream({
  day,
  dayDerived,
  readonly,
  pendingDay,
  transportMode,
  onEditActivity,
  onSelectCard,
  onOpenCardDetail,
  onConflictChoice,
  onOpenConflicts,
}: {
  day: Day
  dayDerived?: DayDerived
  readonly: boolean
  pendingDay?: number | null
  transportMode?: string | null
  onEditActivity: (stopId: string, activityId: string, dayIndex: number) => void
  onSelectCard: (stopId: string, activityId: string, dayIndex: number) => void
  onOpenCardDetail: (stopId: string, activityId: string, dayIndex: number) => void
  onConflictChoice: (conflict: Conflict, optionLabel: string) => void
  onOpenConflicts: () => void
}) {
  const openStopDetail = useUiStore(s => s.openStopDetail)
  /**
   * 卡片流 + 距离行（mindtrip/06 §5）。
   * 相邻 stop 之间插一行；同一天同一对 stop 只出现一次，避免多活动 stop 重复。
   */
  type Row = { stop: Stop; activity: Day['stops'][number]['activities'][number] }
  type Entry = { kind: 'card'; row: Row } | { kind: 'distance'; from: string; to: string }
  const { entries, ordered } = useMemo<{ entries: Entry[]; ordered: Row[] }>(() => {
    const list: Row[] = []
    for (const stop of day.stops) {
      for (const activity of stop.activities) list.push({ stop, activity })
    }
    list.sort((a, b) => {
      const ta = a.activity.timeWindow?.start || '99:99'
      const tb = b.activity.timeWindow?.start || '99:99'
      return ta.localeCompare(tb) || a.stop.seq - b.stop.seq || a.activity.seq - b.activity.seq
    })
    const out: Entry[] = []
    const distances = new Set<string>()
    let previousStopId: string | null = null
    for (const row of list) {
      if (previousStopId && previousStopId !== row.stop.stopId) {
        const key = `${previousStopId}__${row.stop.stopId}`
        if (!distances.has(key)) {
          distances.add(key)
          out.push({ kind: 'distance', from: previousStopId, to: row.stop.stopId })
        }
      }
      out.push({ kind: 'card', row })
      previousStopId = row.stop.stopId
    }
    return { entries: out, ordered: list }
  }, [day])

  // 每张卡的「出发地 / 下一站」：按时间排序后的前一张、后一张卡片
  const neighbors = useMemo(() => {
    const map = new Map<string, { prev: Row | null; next: Row | null }>()
    ordered.forEach((row, index) => {
      map.set(row.activity.activityId, {
        prev: index > 0 ? ordered[index - 1] : null,
        next: index < ordered.length - 1 ? ordered[index + 1] : null,
      })
    })
    return map
  }, [ordered])

  const trip = useTripStore(s => s.trip)
  const originLabel = trip?.constraints?.origin ? `${trip.constraints.origin}（出发）` : null
  // 当天第一张卡的出发地 = 前一天最后一个地点（住宿）；整趟第一张卡退回出发城市
  const firstFromStop = useMemo(() => {
    if (!trip) return null
    const index = trip.days.findIndex(item => item.dayIndex === day.dayIndex)
    const previousDay = index > 0 ? trip.days[index - 1] : null
    return previousDay?.stops.at(-1) ?? null
  }, [trip, day.dayIndex])

  let stayInserted = false

  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === 'distance') {
          return (
            <DistanceRow
              key={`d-${entry.from}-${entry.to}-${index}`}
              fromStopId={entry.from}
              toStopId={entry.to}
              dayIndex={day.dayIndex}
            />
          )
        }
        const { stop, activity } = entry.row
        const neighbor = neighbors.get(activity.activityId)
        const showStayDivider = activity.type === 'stay' && !stayInserted
        if (showStayDivider) stayInserted = true
        return (
          <div key={activity.activityId}>
            {showStayDivider && (
              <div className="stay-divider">
                <Icon name="moon" /> 今晚住宿
              </div>
            )}
            <ActivityCard
              stop={stop}
              day={day}
              activity={activity}
              fromStop={neighbor?.prev?.stop ?? firstFromStop}
              nextStop={neighbor?.next?.stop ?? null}
              originLabel={originLabel}
              dayDerived={dayDerived}
              stopped={pendingDay === day.dayIndex}
              readonly={readonly}
              transportMode={transportMode}
              onEdit={() => onEditActivity(stop.stopId, activity.activityId, day.dayIndex)}
              onSelect={() => onSelectCard(stop.stopId, activity.activityId, day.dayIndex)}
              onOpenDetail={() => onOpenCardDetail(stop.stopId, activity.activityId, day.dayIndex)}
              onOpenFood={
                activity.type === 'meal'
                  ? () => openStopDetail(stop.stopId, { tab: 'food', dayIndex: day.dayIndex })
                  : undefined
              }
              onConflictChoice={onConflictChoice}
              onOpenConflicts={onOpenConflicts}
            />
          </div>
        )
      })}
    </>
  )
}

function findStopInTrip(trip: NonNullable<ReturnType<typeof useTripStore.getState>['trip']>, stopId: string) {
  for (const day of trip.days) {
    for (const stop of day.stops) if (stop.stopId === stopId) return { day, stop }
  }
  return null
}
