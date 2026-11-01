import type { Ticket } from '../types'

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function fmtDate(iso?: string | null): string {
  if (!iso) return '日期待定'
  const parts = iso.slice(0, 10).split('-')
  if (parts.length < 3) return iso
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

export function fmtDateWeek(iso?: string | null): string {
  if (!iso) return '日期待定'
  const dt = new Date(iso.slice(0, 10) + 'T00:00:00')
  return `${fmtDate(iso)} ${WEEK[dt.getDay()]}`
}

export function fmtHM(t?: string | null): string {
  if (!t) return '—'
  return t.slice(0, 5)
}

export function fmtMoney(range?: [number, number] | null, currency = 'CNY'): string {
  if (!range) return '—'
  const [a, b] = range
  if (!a && !b) return '免费'
  const f = (n: number) => `¥${n.toLocaleString('zh-CN')}`
  return a === b ? f(a) : `${f(a)}–${f(b)}`
}

export function fmtPrice(ticket?: Ticket | null): string {
  if (!ticket || ticket.kind === 'none') return '免费'
  return fmtMoney(ticket.priceRange, ticket.currency)
}

export function fmtDur(min?: number | null): string {
  if (min == null || Number.isNaN(min)) return '—'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h ? (m ? `${h}小时${m}分` : `${h}小时`) : `${m}分钟`
}

export function timeDiff(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0
  const [ah, am] = a.split(':').map(Number)
  const [bh, bm] = b.split(':').map(Number)
  let diff = bh * 60 + bm - (ah * 60 + am)
  if (diff < 0) diff += 24 * 60
  return diff
}

export function dayColorVar(dayIndex: number): string {
  return `var(--day-${((dayIndex - 1) % 12) + 1})`
}

export function nowHM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function shortName(name: string): string {
  return name.split(' · ')[0].replace(/^乌鲁木齐 · |^伊宁 · |^特克斯八卦城 · /, m => m.slice(0, -2))
}

/** 当日预算：只累加有票面价的 ticket。meal 是纯时间块（docs/07 §2），
 * 不含餐饮开销 —— 餐饮走每日基线估算，不在这里逐 activity 累加。 */
export function dayBudget(day: { stops: { activities: { ticket?: Ticket | null }[] }[] }): number {
  let sum = 0
  for (const stop of day.stops) {
    for (const act of stop.activities) {
      const tk = act.ticket
      if (tk && tk.priceRange && tk.kind !== 'none') sum += (tk.priceRange[0] + tk.priceRange[1]) / 2
    }
  }
  return Math.round(sum)
}

export function weekday(iso?: string | null): string {
  if (!iso) return ''
  return WEEK[new Date(iso.slice(0, 10) + 'T00:00:00').getDay()]
}

export function daysBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null
  const a = new Date(start.slice(0, 10) + 'T00:00:00').getTime()
  const b = new Date(end.slice(0, 10) + 'T00:00:00').getTime()
  return Math.round((b - a) / 86400000) + 1
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
