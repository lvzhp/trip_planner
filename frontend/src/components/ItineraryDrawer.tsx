import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../lib/icons'
import { fmtDate, fmtMoney } from '../lib/format'
import { DistanceRow } from './DistanceRow'
import { toast } from '../lib/toast'
import type { Day, Stop } from '../types'

type Tab = 'plan' | 'budget' | 'booking'

/**
 * 行程抽屉（mindtrip/06 §7）：文档层，覆盖地图但不挤占——打开时地图
 * `setRightInset` 同步，关闭后地图保持原视野（不重新 fit）。
 *
 * 桌面宽 440px（可拖 360–560）；移动端 90% 高 bottom sheet（CSS 负责）。
 */
export function ItineraryDrawer() {
  const open = useUiStore(s => s.itineraryOpen)
  const close = useUiStore(s => s.closeItinerary)
  const width = useUiStore(s => s.itineraryWidth)
  const setWidth = useUiStore(s => s.setItineraryWidth)
  const openStopDetail = useUiStore(s => s.openStopDetail)
  const trip = useTripStore(s => s.trip)
  const derived = useTripStore(s => s.derived)
  const readonly = useTripStore(s => s.readonly)
  const reorderDay = useTripStore(s => s.reorderDay)
  const [tab, setTab] = useState<Tab>('plan')
  const [openDays, setOpenDays] = useState<Record<number, boolean>>({})
  const [history, setHistory] = useState<{ dayIndex: number; stopIds: string[] }[]>([])
  const [future, setFuture] = useState<{ dayIndex: number; stopIds: string[] }[]>([])
  const dragRef = useRef<{ dayIndex: number; stopId: string } | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || target.closest('.itinerary-drawer')) return
      // 地图上的点击不关闭：用户是在操作地图
      if (target.closest('.map-pane') && !target.closest('.map-toolbar')) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, close])

  useEffect(() => {
    if (!open || !trip) return
    setOpenDays(prev => {
      if (Object.keys(prev).length) return prev
      const next: Record<number, boolean> = {}
      trip.days.forEach((day, index) => {
        next[day.dayIndex] = index === 0
      })
      return next
    })
  }, [open, trip])

  const stopsTotal = useMemo(
    () => (trip?.days || []).reduce((sum, day) => sum + day.stops.length, 0),
    [trip?.days],
  )

  if (!open || !trip) return null

  const onResizeStart = (event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const move = (ev: PointerEvent) => setWidth(startWidth + (startX - ev.clientX))
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-drawer')
    }
    document.body.classList.add('resizing-drawer')
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const dropOn = async (day: Day, targetStop: Stop) => {
    const source = dragRef.current
    dragRef.current = null
    if (!source || source.dayIndex !== day.dayIndex || source.stopId === targetStop.stopId) return
    const ids = day.stops.map(stop => stop.stopId)
    const from = ids.indexOf(source.stopId)
    const to = ids.indexOf(targetStop.stopId)
    if (from < 0 || to < 0) return
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, source.stopId)
    setHistory(list => [...list, { dayIndex: day.dayIndex, stopIds: ids }])
    setFuture([])
    await reorderDay(day.dayIndex, next, { silent: true })
    toast(`Day ${day.dayIndex} 顺序已更新`, 'checkCircle')
  }

  const undo = async () => {
    const last = history[history.length - 1]
    if (!last) return
    setHistory(list => list.slice(0, -1))
    setFuture(list => [...list, last])
    await reorderDay(last.dayIndex, last.stopIds, { silent: true })
  }

  const redo = async () => {
    const next = future[future.length - 1]
    if (!next) return
    setFuture(list => list.slice(0, -1))
    setHistory(list => [...list, next])
    await reorderDay(next.dayIndex, next.stopIds, { silent: true })
  }

  const budget = derived?.budgetSummary

  return (
    <>
      <div className="itinerary-scrim" role="presentation" onClick={close} />
      <aside
        className="itinerary-drawer"
        style={{ width }}
        role="dialog"
        aria-modal="false"
        aria-label="行程文档"
      >
        <div className="id-resize" role="separator" aria-label="拖动调整抽屉宽度" onPointerDown={onResizeStart} />
        <header className="id-head">
          <div>
            <h2>{trip.title || '行程文档'}</h2>
            <div className="id-sub">
              v{trip.version} · {trip.days.length} 天 · {stopsTotal} 个地点 · {trip.constraints.travelers} 人
            </div>
          </div>
          <div className="id-head-actions">
            <a
              className="icon-btn id-ics"
              href={api.exportIcsUrl(trip.tripId)}
              download
              title="导出日历 ICS"
              aria-label="导出日历 ICS"
            >
              <Icon name="calendar" />
            </a>
            <button
              className="icon-btn"
              type="button"
              title="打印行程单"
              aria-label="打印行程单"
              onClick={() => {
                document.body.classList.add('printing-itinerary')
                window.setTimeout(() => window.print(), 60)
                window.setTimeout(() => document.body.classList.remove('printing-itinerary'), 800)
              }}
            >
              <Icon name="download" />
            </button>
            <button className="icon-btn" type="button" aria-label="撤销重排" disabled={!history.length} onClick={() => void undo()}>
              <Icon name="history" />
            </button>
            <button className="icon-btn" type="button" aria-label="重做重排" disabled={!future.length} onClick={() => void redo()}>
              <Icon name="arrowUpRight" />
            </button>
            <button className="icon-btn" type="button" aria-label="关闭行程文档" onClick={close}>
              <Icon name="x" />
            </button>
          </div>
        </header>

        <div className="id-params">
          <span>{trip.constraints.destination || trip.days[0]?.stops[0]?.poi.city || '目的地待定'}</span>
          <span>
            {fmtDate(trip.constraints.dateRange?.start)}–{fmtDate(trip.constraints.dateRange?.end)}
          </span>
          <span>{trip.constraints.travelers} 人</span>
          <span>{trip.constraints.budget?.total ? `¥${Math.round(trip.constraints.budget.total).toLocaleString()}` : '预算待定'}</span>
          <span>
            {trip.constraints.pace === 'relaxed' ? '轻松' : trip.constraints.pace === 'intense' ? '紧凑' : '正常'}
          </span>
        </div>

        <div className="id-tabs" role="tablist" aria-label="行程文档分区">
          {[
            ['plan', '行程'],
            ['budget', '预算'],
            ['booking', '预订'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key as Tab)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="id-body">
          {tab === 'plan' &&
            trip.days.map(day => {
              const isOpen = openDays[day.dayIndex] ?? false
              const dayDerived = derived?.days.find(item => item.dayIndex === day.dayIndex)
              return (
                <section className={`id-day${isOpen ? ' open' : ''}`} key={day.dayIndex}>
                  <button
                    type="button"
                    className="id-day-head"
                    aria-expanded={isOpen}
                    onClick={() => setOpenDays(prev => ({ ...prev, [day.dayIndex]: !isOpen }))}
                  >
                    <span className="id-day-swatch" style={{ ['--day-color' as string]: `var(--day-${((day.dayIndex - 1) % 12) + 1})` } as React.CSSProperties} />
                    <span className="id-day-title">
                      Day {day.dayIndex} · {day.theme || '暂无主题'}
                    </span>
                    <span className="id-day-meta">
                      {fmtDate(day.date)} · {day.stops.length} 站
                      {dayDerived ? ` · ${dayDerived.loadHours}h` : ''}
                    </span>
                    <Icon name={isOpen ? 'caretDown' : 'caretRight'} />
                  </button>
                  {isOpen && (
                    <div className="id-day-body">
                      {day.stops.length === 0 && <div className="id-empty">这一天还没有安排。</div>}
                      {day.stops.map((stop, index) => (
                        <div key={stop.stopId}>
                          {index > 0 && (
                            <DistanceRow
                              fromStopId={day.stops[index - 1].stopId}
                              toStopId={stop.stopId}
                              dayIndex={day.dayIndex}
                            />
                          )}
                          <div
                            className={`id-stop${readonly ? '' : ' draggable'}`}
                            draggable={!readonly}
                            onDragStart={() => {
                              dragRef.current = { dayIndex: day.dayIndex, stopId: stop.stopId }
                            }}
                            onDragOver={event => {
                              if (readonly) return
                              event.preventDefault()
                            }}
                            onDrop={event => {
                              event.preventDefault()
                              void dropOn(day, stop)
                            }}
                          >
                            <span className="id-stop-handle" aria-hidden="true">
                              <Icon name="grip" />
                            </span>
                            <span className="id-stop-seq">{index + 1}</span>
                            <div className="id-stop-main">
                              <div className="id-stop-name">{stop.poi.name.split(' · ').slice(-1)[0]}</div>
                              <div className="id-stop-sub">
                                {stop.activities[0]?.timeWindow.start}–{stop.activities[stop.activities.length - 1]?.timeWindow.end}
                                {' · '}
                                {stop.activities.length} 项安排
                              </div>
                              <div className="id-stop-acts">
                                {stop.activities.map(activity => (
                                  <button
                                    key={activity.activityId}
                                    type="button"
                                    className={`id-act${activity.type === 'stay' ? ' stay' : ''}`}
                                    onClick={() =>
                                      openStopDetail(stop.stopId, {
                                        tab: 'overview',
                                        dayIndex: day.dayIndex,
                                        activityId: activity.activityId,
                                      })
                                    }
                                    title={activity.title}
                                  >
                                    {activity.timeWindow.start} {activity.title}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="btn btn-sm id-stop-detail"
                              onClick={() =>
                                openStopDetail(stop.stopId, {
                                  tab: 'overview',
                                  dayIndex: day.dayIndex,
                                  activityId: stop.activities[0]?.activityId ?? null,
                                })
                              }
                            >
                              详情
                            </button>
                          </div>
                        </div>
                      ))}
                      {!readonly && (
                        <div className="id-day-tip">拖住某一行可调整当天顺序；改完可点右上撤销。</div>
                      )}
                    </div>
                  )}
                </section>
              )
            })}

          {tab === 'budget' && budget && (
            <div className="id-budget">
              <div className="id-budget-row">
                <span>门票</span>
                <strong>{fmtMoney([budget.ticketsTotal, budget.ticketsTotal])}</strong>
              </div>
              {/* 住宿收缩为区域级（new-plan 01 §10）：预算不含住宿，不再显示住宿行 */}
              <div className="id-budget-row">
                <span>餐饮预估</span>
                <strong>{fmtMoney([budget.foodEstTotal, budget.foodEstTotal])}</strong>
              </div>
              <div className="id-budget-row">
                <span>交通（机票/租车/油费）</span>
                <strong>{fmtMoney([budget.transitEstTotal, budget.transitEstTotal])}</strong>
              </div>
              <div className="id-budget-total">
                <span>合计</span>
                <strong>{fmtMoney([budget.grandTotal, budget.grandTotal])}</strong>
              </div>
              <div className="id-budget-row">
                <span>人均</span>
                <strong>{fmtMoney([budget.perPerson, budget.perPerson])}</strong>
              </div>
              <div className="id-budget-note">
                {budget.overBudgetBy > 0
                  ? `超出预算 ¥${Math.round(budget.overBudgetBy).toLocaleString()}，可在参数 chips 里调整预算或减少项目。预算不含住宿。`
                  : '当前在预算范围内。预算不含住宿（只排住在哪个地点），也不含临时消费。'}
              </div>
            </div>
          )}

          {tab === 'booking' && (
            <div className="id-booking">
              {(derived?.bookingTimeline || []).map(item => (
                <div className="id-booking-row" key={item.id || item.activityId || item.title}>
                  <span className="id-booking-date">{fmtDate(item.orderBy)}</span>
                  <span className="id-booking-main">
                    <strong>{item.title}</strong>
                    <em>
                      {item.channelHint || '渠道待补充'} · Day {item.dayIndex ?? '—'} · 提前 {item.leadTimeDays ?? '—'} 天
                      {item.saleHint ? ` · ${item.saleHint}` : ''}
                      {item.channelStatus === 'clue' ? ' · 来自游记，未经官方核实' : ''}
                    </em>
                  </span>
                  <span className="id-booking-price">{fmtMoney(item.priceRange)}</span>
                </div>
              ))}
              {!derived?.bookingTimeline.length && <div className="id-empty">没有需要预订的项。</div>}
              <button
                type="button"
                className="btn btn-sm id-booking-more"
                onClick={() => useUiStore.getState().openDrawer('booking')}
              >
                打开预订提醒面板
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
