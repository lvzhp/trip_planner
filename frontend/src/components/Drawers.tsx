import { useEffect, useMemo, useState } from 'react'
import type { Conflict, Trip, VersionItem } from '../types'
import { api } from '../api/client'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../lib/icons'
import { fmtDate, fmtMoney, relativeTime } from '../lib/format'
import { toast } from '../lib/toast'
import { bookingKindLabel, conflictTypeLabel } from '../lib/icons'

export function Drawers({ onJump, onConflictChoice }: { onJump: (conflict: Conflict) => void; onConflictChoice: (conflict: Conflict, label: string) => void }) {
  const drawer = useUiStore(s => s.drawer)
  const closeDrawer = useUiStore(s => s.closeDrawer)
  const readonly = useTripStore(s => s.readonly)
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer, closeDrawer])
  if (!drawer) return null
  return (
    <>
      <div className="drawer-scrim open" onClick={closeDrawer} />
      <aside className={`drawer open drawer-${drawer}`} role="dialog" aria-modal="true">
        {drawer === 'version' && <VersionDrawer onClose={closeDrawer} readonly={readonly} />}
        {drawer === 'booking' && <BookingDrawer onClose={closeDrawer} />}
        {drawer === 'conflict' && <ConflictDrawer onClose={closeDrawer} onJump={onJump} onConflictChoice={onConflictChoice} />}
      </aside>
    </>
  )
}

function DrawerHead({ title, sub, onClose }: { title: string; sub?: React.ReactNode; onClose: () => void }) {
  return (
    <div className="drawer-head">
      <div>
        <div className="dh-title">{title}</div>
        {sub && <div className="dh-sub">{sub}</div>}
      </div>
      <button className="icon-btn" type="button" data-close-drawer aria-label="关闭" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  )
}

function VersionDrawer({ onClose, readonly }: { onClose: () => void; readonly: boolean }) {
  const trip = useTripStore(s => s.trip)
  const version = trip?.version || 0
  const [versions, setVersions] = useState<VersionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ version: number; rows: { op: string; text: string }[] } | null>(null)

  useEffect(() => {
    if (!trip) return
    setLoading(true)
    api
      .versions(trip.tripId)
      .then(data => setVersions(data.versions))
      .catch(err => toast(err instanceof Error ? err.message : '版本历史加载失败', 'xCircle'))
      .finally(() => setLoading(false))
  }, [trip?.tripId])

  const togglePreview = async (item: VersionItem) => {
    if (preview?.version === item.version) {
      setPreview(null)
      return
    }
    if (!trip) return
    if (item.version === trip.version) {
      setPreview({ version: item.version, rows: [{ op: 'keep', text: '当前版本，没有 diff' }] })
      return
    }
    if (!item.available) {
      toast(`v${item.version} 只有摘要，没有可恢复的快照`, 'info')
      return
    }
    try {
      const detail = await api.version(trip.tripId, item.version)
      setPreview({ version: item.version, rows: diffTrips(trip, detail.trip) })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'diff 加载失败', 'xCircle')
    }
  }

  const restore = async (item: VersionItem) => {
    if (!trip || !item.available) return
    if (!window.confirm(`恢复到 v${item.version}？当前 v${trip.version} 会保留在历史里。`)) return
    try {
      const detail = await api.restore(trip.tripId, item.version)
      useTripStore.setState({ trip: detail.trip, derived: detail.derived, events: detail.events, lastSeq: detail.lastSeq })
      toast(`已恢复到 v${item.version}`)
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '恢复失败', 'xCircle')
    }
  }

  return (
    <>
      <DrawerHead title="版本历史" sub={`线性时间轴 · 共 ${versions.length} 个版本 · 点击版本查看与当前的 diff`} onClose={onClose} />
      <div className="drawer-body">
        {loading && <div className="drawer-loading"><span className="spinner" /> 加载中…</div>}
        <div className="version-list">
          {versions.map(item => (
            <div className={`version-item${item.version === version ? ' current' : ''}`} key={item.version}>
              <div className="v-rail">
                <span className="v-dot" />
                <span className="v-line" />
              </div>
              <div className="v-main">
                <div className="v-head">
                  <span className="v-no">v{item.version}</span>
                  <span className="v-time">{relativeTime(item.createdAt)}</span>
                  {item.version === version && <span className="v-current-tag">当前版本</span>}
                  {!item.available && <span className="chip" style={{ height: 18, fontSize: 10 }}>仅摘要</span>}
                </div>
                {item.userRequest && (
                  <div className="v-quote">
                    <Icon name="quote" /> <q>{item.userRequest}</q>
                  </div>
                )}
                <div className="v-summary">{item.summary}</div>
                <div className="v-ops">
                  {item.opCount} 处改动
                  {item.changedStopIds[0] === '*' ? ' · 全程' : ` · ${item.changedStopIds.length} 个地点`}
                </div>
                {item.version !== version && item.available && (
                  <div className="v-actions">
                    <button className="btn btn-sm" type="button" onClick={() => togglePreview(item)}>
                      <Icon name="eye" /> {preview?.version === item.version ? '收起 diff' : '预览 diff'}
                    </button>
                    {!readonly && item.available && (
                      <button className="btn btn-sm btn-primary" type="button" onClick={() => restore(item)}>
                        恢复到此版本
                      </button>
                    )}
                  </div>
                )}
                {preview?.version === item.version && (
                  <div className="diff-preview" style={{ display: 'block' }}>
                    <div className="diff-preview-title">
                      v{item.version} → v{version} 变更
                      <span className="legend">
                        <span className="l-add"><i />增</span>
                        <span className="l-del"><i />删</span>
                        <span className="l-mod"><i />改</span>
                      </span>
                    </div>
                    {preview.rows.map((r, i) => (
                      <div className={`diff-row ${r.op === 'add' ? 'd-add' : r.op === 'del' ? 'd-del' : r.op === 'mod' ? 'd-mod' : ''}`} key={i}>
                        <span className="d-op">{{ add: '新增', del: '删除', mod: '修改', keep: '未变' }[r.op] || r.op}</span>
                        <span className="d-text">{r.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function diffTrips(current: Trip, old: Trip): { op: string; text: string }[] {
  const rows: { op: string; text: string }[] = []
  const oldRhythm = new Map(old.days.map(d => [d.dayIndex, d.rhythm]))
  for (const day of current.days) {
    const before = oldRhythm.get(day.dayIndex)
    if (before && (before.wake !== day.rhythm.wake || before.sleep !== day.rhythm.sleep)) {
      rows.push({ op: 'mod', text: `Day ${day.dayIndex} 作息 ${before.wake}–${before.sleep} → ${day.rhythm.wake}–${day.rhythm.sleep}` })
    }
  }
  const oldStops = new Map(old.days.flatMap(d => d.stops).map(s => [s.stopId, s]))
  const newStops = new Map(current.days.flatMap(d => d.stops).map(s => [s.stopId, s]))
  for (const [id, stop] of newStops) {
    if (!oldStops.has(id)) rows.push({ op: 'add', text: `新增地点「${stop.poi.name}」` })
  }
  for (const [id, stop] of oldStops) {
    if (!newStops.has(id)) rows.push({ op: 'del', text: `删除地点「${stop.poi.name}」` })
  }
  const oldActs = new Map(old.days.flatMap(d => d.stops).flatMap(s => s.activities).map(a => [a.activityId, a]))
  for (const day of current.days) {
    for (const stop of day.stops) {
      for (const act of stop.activities) {
        const before = oldActs.get(act.activityId)
        if (!before) {
          rows.push({ op: 'add', text: `Day ${day.dayIndex} 新增「${act.title}」 ${act.timeWindow.start}–${act.timeWindow.end}` })
        } else if (before.timeWindow.start !== act.timeWindow.start || before.timeWindow.end !== act.timeWindow.end) {
          rows.push({
            op: 'mod',
            text: `Day ${day.dayIndex}「${act.title}」${before.timeWindow.start}–${before.timeWindow.end} → ${act.timeWindow.start}–${act.timeWindow.end}`,
          })
        } else if (before.title !== act.title) {
          rows.push({ op: 'mod', text: `Day ${day.dayIndex}「${before.title}」→「${act.title}」` })
        }
      }
    }
  }
  for (const [id, act] of oldActs) {
    if (!current.days.some(d => d.stops.some(s => s.activities.some(a => a.activityId === id)))) {
      rows.push({ op: 'del', text: `删除「${act.title}」` })
    }
  }
  return rows.length ? rows.slice(0, 40) : [{ op: 'keep', text: '两个版本没有结构化差异' }]
}

function BookingDrawer({ onClose }: { onClose: () => void }) {
  const derived = useTripStore(s => s.derived)
  const done = useUiStore(s => s.bookingDone)
  const toggle = useUiStore(s => s.toggleBooking)
  if (!derived) return null
  const today = derived.today
  const items = [...derived.bookingTimeline].sort((a, b) => (a.orderBy || '').localeCompare(b.orderBy || ''))
  const groups: { date: string; items: typeof items }[] = []
  for (const it of items) {
    const date = it.orderBy || '待定'
    const g = groups.find(x => x.date === date)
    if (g) g.items.push(it)
    else groups.push({ date, items: [it] })
  }
  const doneCount = done.filter(id =>
    items.some(it => (it.id || it.activityId || it.title) === id),
  ).length
  return (
    <>
      <DrawerHead title="预订提醒" sub={`按「应该在哪个日期下单」倒排 · 今天 ${fmtDate(today)}`} onClose={onClose} />
      <div className="drawer-body">
        <div className="booking-list">
          <div className="booking-summary">
            <span>
              共 <strong className="num">{items.length}</strong> 项 · 已完成 <strong className="num">{doneCount}</strong> 项
            </span>
            <span className="bs-progress">
              <i style={{ width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }} />
            </span>
          </div>
          {groups.map(g => {
            const overdue = g.date !== '待定' && g.date < today
            return (
              <div key={g.date}>
                <div className="booking-group-label">
                  <Icon name="calendar" /> {g.date === '待定' ? '日期待定' : `${fmtDate(g.date)} 前`}
                  {overdue && <span className="overdue-tag"> · 已逾期</span>}
                </div>
                {g.items.map(it => {
                  const id = it.id || it.activityId || it.title
                  const isDone = done.includes(id)
                  return (
                    <div className={`booking-item${isDone ? ' done' : ''}${overdue && !isDone ? ' overdue' : ''}`} key={id}>
                      <button
                        className="booking-check"
                        type="button"
                        role="checkbox"
                        aria-checked={isDone}
                        aria-label={`标记 ${it.title} 已订`}
                        onClick={() => toggle(id)}
                      >
                        <Icon name="check" />
                      </button>
                      <div className="bi-main">
                        <div className="bi-title">
                          <span className="bi-kind">{bookingKindLabel[it.kind] || it.kind}</span>
                          {it.title}
                        </div>
                        <div className="bi-sub">
                          {it.channelHint || '渠道待补充'} · <span className="num">{fmtMoney(it.priceRange)}</span>
                          {it.realNameRequired ? ' · 实名' : ''} · 提前 {it.leadTimeDays ?? '—'} 天 · Day {it.dayIndex ?? '—'}
                        </div>
                        {overdue && !isDone && (
                          <div className="bi-overdue">
                            <Icon name="warn" /> 已过建议下单日期（今天 {fmtDate(today)}），票量紧张请尽快
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {items.length === 0 && <div className="panel-empty">当前行程没有需要预订的项。</div>}
        </div>
      </div>
    </>
  )
}

function ConflictDrawer({ onClose, onJump, onConflictChoice }: { onClose: () => void; onJump: (c: Conflict) => void; onConflictChoice: (c: Conflict, label: string) => void }) {
  const derived = useTripStore(s => s.derived)
  const readonly = useTripStore(s => s.readonly)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const sorted = useMemo(
    () => [...(derived?.conflicts || [])].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)),
    [derived],
  )
  if (!derived) return null
  const errs = sorted.filter(c => c.severity === 'error').length
  const warns = sorted.length - errs
  const choose = (c: Conflict, label: string) => {
    const key = c.id || c.message
    setChosen(prev => ({ ...prev, [key]: label }))
    onConflictChoice(c, label)
    onClose()
  }
  return (
    <>
      <DrawerHead
        title="校验冲突"
        sub={
          <>
            <span style={{ color: 'var(--error)' }}>{errs} 个错误</span> · <span style={{ color: 'var(--warning)' }}>{warns} 个警告</span> · 按严重度排序
          </>
        }
        onClose={onClose}
      />
      <div className="drawer-body">
        <div className="conflict-list">
          {sorted.map((c, idx) => {
            const key = c.id || c.message
            return (
              <div
                className={`conflict-item severity-${c.severity}`}
                key={key}
                tabIndex={0}
                role="button"
                onClick={e => {
                  if ((e.target as Element).closest('.ask-opt')) return
                  onJump(c)
                  onClose()
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    onJump(c)
                    onClose()
                  }
                }}
              >
                <div className="ci-head">
                  <span className="ci-type">
                    <Icon name={c.severity === 'error' ? 'xCircle' : 'warn'} /> {conflictTypeLabel[c.type] || c.type} ·{' '}
                    {c.severity === 'error' ? '错误' : '警告'}
                  </span>
                  <span className="ci-day">{c.dayIndex ? `Day ${c.dayIndex}` : '全程'}</span>
                </div>
                <div className="ci-msg">{c.message}</div>
                <div className="ci-jump">
                  <Icon name="arrowUpRight" /> 点击跳转到对应卡片 / 地图位置
                </div>
                <div className="ci-ask">
                  {c.askUser ? (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                        <Icon name="chat" /> {c.askUser.questions[0]?.question}
                      </div>
                      <div className="ask-options">
                        {c.askUser.questions[0]?.options.map(o => (
                          <button
                            className={`ask-opt${chosen[key] === o.label ? ' selected' : ''}`}
                            type="button"
                            key={o.id}
                            disabled={readonly || !!chosen[key]}
                            onClick={e => {
                              e.stopPropagation()
                              choose(c, o.label)
                            }}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="fix-title" style={{ fontSize: 12, fontWeight: 700, display: 'flex', gap: 5, alignItems: 'center', color: 'var(--text)' }}>
                        <Icon name="sparkle" /> 建议修法
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                        {c.suggestedFix || '暂无自动修复建议，可在对话中告诉我怎么处理。'}
                      </div>
                    </>
                  )}
                </div>
                {idx === 0 && <span className="sr-only">最严重的冲突</span>}
              </div>
            )
          })}
          {sorted.length === 0 && <div className="panel-empty">校验通过，没有冲突。</div>}
        </div>
      </div>
    </>
  )
}
