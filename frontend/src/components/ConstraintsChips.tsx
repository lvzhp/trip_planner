import { useEffect, useMemo, useRef, useState } from 'react'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../lib/icons'
import { fmtDate } from '../lib/format'
import { toast } from '../lib/toast'
import type { Pace } from '../types'

const PACE_OPTIONS: { value: 'relaxed' | 'normal' | 'packed'; label: string }[] = [
  { value: 'relaxed', label: '轻松' },
  { value: 'normal', label: '正常' },
  { value: 'packed', label: '紧凑' },
]

function paceOf(value: Pace | undefined): 'relaxed' | 'normal' | 'packed' {
  if (value === 'relaxed') return 'relaxed'
  if (value === 'intense') return 'packed'
  return 'normal'
}

function fmtBudget(value?: number | null): string {
  if (value == null) return '预算待定'
  if (value >= 1000) return `¥${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`
  return `¥${Math.round(value)}`
}

/**
 * 参数条 chips（mindtrip/06 §6）：`京都 / 11月2–6 / 2人 / ¥8k / 轻松`。
 *
 * 放在地图顶栏而不是对话顶栏；点击弹 popover 就地改约束。提交走
 * `PATCH /trips/{id}/constraints`，服务端只动受影响的字段并发 plan_patch。
 * 日期与已有天冲突时，先让用户选「保留多余天（平移日期）」还是「删除超出的天」。
 */
export function ConstraintsChips() {
  const trip = useTripStore(s => s.trip)
  const readonly = useTripStore(s => s.readonly)
  const updateConstraints = useTripStore(s => s.updateConstraints)
  const openItinerary = useUiStore(s => s.openItinerary)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [recalcText, setRecalcText] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ span: number; days: number } | null>(null)
  const [form, setForm] = useState({
    destination: '',
    start: '',
    end: '',
    travelers: 2,
    budget: '',
    pace: 'normal' as 'relaxed' | 'normal' | 'packed',
  })
  const anchorRef = useRef<HTMLDivElement>(null)

  const constraints = trip?.constraints
  const days = trip?.days || []
  const city = useMemo(() => {
    if (constraints?.destination) return constraints.destination
    const first = days[0]?.stops[0]?.poi.city
    return first || trip?.title || '目的地待定'
  }, [constraints?.destination, days, trip?.title])

  const dateText = useMemo(() => {
    const start = constraints?.dateRange?.start
    const end = constraints?.dateRange?.end
    if (start && end) return `${fmtDate(start)}–${fmtDate(end)}`
    return '日期待定'
  }, [constraints?.dateRange?.start, constraints?.dateRange?.end])

  useEffect(() => {
    if (!open || !constraints) return
    setForm({
      destination: constraints.destination || '',
      start: constraints.dateRange?.start || '',
      end: constraints.dateRange?.end || '',
      travelers: constraints.travelers || 2,
      budget: constraints.budget?.total != null ? String(Math.round(constraints.budget.total)) : '',
      pace: paceOf(constraints.pace),
    })
    setConflict(null)
  }, [open, constraints])

  if (!trip) return null

  const submit = async (syncDays?: 'shift' | 'trim') => {
    if (readonly) {
      toast('只读分享不能修改参数', 'info')
      return
    }
    setSaving(true)
    const datesChanged = form.start !== (constraints?.dateRange?.start || '') || form.end !== (constraints?.dateRange?.end || '')
    setRecalcText(datesChanged ? `正在重算 ${days.length} 天的日期与预算…` : '正在更新人数与预算…')
    const ok = await updateConstraints({
      destination: form.destination.trim() || null,
      startDate: form.start || null,
      endDate: form.end || null,
      travelers: form.travelers,
      budget: form.budget ? Number(form.budget) : null,
      pace: form.pace,
      syncDays: syncDays ?? null,
    })
    setSaving(false)
    setRecalcText(null)
    if (ok) {
      setOpen(false)
      setConflict(null)
    }
  }

  const onSave = () => {
    if (form.start && form.end && days.length) {
      const span = Math.max(
        1,
        Math.round((new Date(form.end).getTime() - new Date(form.start).getTime()) / 86400000) + 1,
      )
      if (span < days.length) {
        setConflict({ span, days: days.length })
        return
      }
    }
    void submit()
  }

  return (
    <div className="constraints-chips" ref={anchorRef}>
      <button type="button" className="cc-chip" onClick={() => setOpen(v => !v)} title="修改目的地">
        <Icon name="pin" /> {city}
      </button>
      <button type="button" className="cc-chip" onClick={() => setOpen(v => !v)} title="修改日期">
        <Icon name="calendar" /> {dateText}
      </button>
      <button type="button" className="cc-chip" onClick={() => setOpen(v => !v)} title="修改人数">
        <Icon name="user" /> {constraints?.travelers || 2}人
      </button>
      <button type="button" className="cc-chip" onClick={() => setOpen(v => !v)} title="修改预算">
        <Icon name="ticket" /> {fmtBudget(constraints?.budget?.total)}
      </button>
      <button type="button" className="cc-chip" onClick={() => setOpen(v => !v)} title="修改节奏">
        <Icon name="walk" /> {PACE_OPTIONS.find(p => p.value === paceOf(constraints?.pace))?.label}
      </button>
      {saving && (
        <span className="cc-recalc" role="status">
          <span className="spinner spinner-xs" /> {recalcText || '正在重算…'}
        </span>
      )}

      {open && (
        <>
          <span className="cc-scrim" role="presentation" onClick={() => setOpen(false)} />
          <div className="cc-popover" role="dialog" aria-label="行程参数">
            <div className="cc-head">
              <strong>行程参数</strong>
              <button className="icon-btn" type="button" aria-label="关闭" onClick={() => setOpen(false)}>
                <Icon name="x" />
              </button>
            </div>
            <label className="cc-field">
              <span>目的地</span>
              <input
                type="text"
                value={form.destination}
                placeholder="例如：京都"
                onChange={event => setForm({ ...form, destination: event.target.value })}
              />
            </label>
            <div className="cc-grid">
              <label className="cc-field">
                <span>开始日期</span>
                <input type="date" value={form.start} onChange={event => setForm({ ...form, start: event.target.value })} />
              </label>
              <label className="cc-field">
                <span>结束日期</span>
                <input type="date" value={form.end} onChange={event => setForm({ ...form, end: event.target.value })} />
              </label>
            </div>
            <div className="cc-grid">
              <label className="cc-field">
                <span>人数</span>
                <span className="cc-stepper">
                  <button type="button" aria-label="减少人数" onClick={() => setForm({ ...form, travelers: Math.max(1, form.travelers - 1) })}>
                    −
                  </button>
                  <span>{form.travelers}</span>
                  <button type="button" aria-label="增加人数" onClick={() => setForm({ ...form, travelers: Math.min(30, form.travelers + 1) })}>
                    +
                  </button>
                </span>
              </label>
              <label className="cc-field">
                <span>预算（总）</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={form.budget}
                  placeholder="例如 8000"
                  onChange={event => setForm({ ...form, budget: event.target.value })}
                />
              </label>
            </div>
            <div className="cc-field">
              <span>节奏</span>
              <div className="cc-seg" role="group" aria-label="节奏">
                {PACE_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    className={form.pace === option.value ? 'active' : ''}
                    aria-pressed={form.pace === option.value}
                    onClick={() => setForm({ ...form, pace: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {conflict && (
              <div className="cc-conflict">
                <p>
                  新日期只有 <strong>{conflict.span}</strong> 天，但行程有 <strong>{conflict.days}</strong> 天。
                </p>
                <div className="cc-conflict-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void submit('shift')}>
                    保留多余天（平移日期）
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => void submit('trim')}>
                    删除超出的 {conflict.days - conflict.span} 天
                  </button>
                </div>
              </div>
            )}

            <div className="cc-foot">
              <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
                取消
              </button>
              {conflict ? (
                <button type="button" className="btn btn-sm" onClick={() => setConflict(null)}>
                  返回修改
                </button>
              ) : (
                <button type="button" className="btn btn-sm btn-primary" onClick={onSave} disabled={saving}>
                  {saving ? <span className="spinner spinner-xs" /> : '保存并重算'}
                </button>
              )}
              <button type="button" className="pc-link" onClick={openItinerary}>
                查看行程文档
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
