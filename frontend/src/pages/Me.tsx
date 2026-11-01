import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { TripSummary, UserProfile } from '../types'
import { useListStore } from '../stores/listStore'
import { useUiStore } from '../stores/uiStore'
import { fmtDate, relativeTime } from '../lib/format'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'
import { runtime, platformLabel } from '../platform/runtime'

/**
 * 「我的」：长期偏好 + 旅行历史 + 设置入口。
 * 对应高德「我的」的结构，但把「个人偏好」做成行程规划真正会读的数据。
 */
export function Me() {
  const navigate = useNavigate()
  const createTrip = useListStore(s => s.createTrip)
  const theme = useUiStore(s => s.theme)
  const toggleTheme = useUiStore(s => s.toggleTheme)
  const openSettings = useUiStore(s => s.openSettings)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [diet, setDiet] = useState<string[]>([])
  const [taste, setTaste] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    document.title = '我的 · Trace Planner'
    return () => {
      document.title = 'Trace Planner'
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.profile().catch(() => null),
      api.trips().catch(() => ({ trips: [] as TripSummary[] })),
    ])
      .then(([p, list]) => {
        if (cancelled) return
        if (p) {
          setProfile(p)
          setDiet(p.diet || [])
          setTaste(p.taste || [])
        }
        setTrips(list.trips || [])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const stats = useMemo(() => {
    const days = trips.reduce((sum, t) => sum + (t.days || 0), 0)
    const dests = new Set(trips.map(t => t.dest).filter(Boolean))
    const pending = trips.filter(t => !t.days).length
    return { days, dests: dests.size, pending }
  }, [trips])

  const history = useMemo(
    () =>
      [...trips].sort((a, b) => {
        const av = a.dateStart || '9999'
        const bv = b.dateStart || '9999'
        return bv.localeCompare(av)
      }),
    [trips],
  )

  const options = profile?.options || { diet: [], taste: [] }

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter(x => x !== value) : [...list, value])
  }

  const saveProfile = async () => {
    setSaving(true)
    try {
      const saved = await api.updateProfile({ diet, taste })
      setProfile(saved)
      toast('偏好已保存，之后的规划会自动带入')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'xCircle')
    } finally {
      setSaving(false)
    }
  }

  const onNewTrip = async () => {
    setCreating(true)
    try {
      const id = await createTrip('未命名行程')
      if (id) navigate(`/t/${id}`)
      else toast('创建行程失败', 'xCircle')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="me-page">
      <header className="me-head">
        <div className="me-avatar" aria-hidden="true">
          <Icon name="logo" />
        </div>
        <div className="me-head-main">
          <h1>旅行者</h1>
          <p>单用户本地模式 · 所有行程由服务端持有</p>
        </div>
        <Link className="btn btn-sm me-back" to="/">
          返回行程
        </Link>
        <button className="icon-btn me-head-btn" type="button" aria-label="接入与设置" onClick={openSettings}>
          <Icon name="settings" />
        </button>
      </header>

      <section className="me-stats" aria-label="旅行统计">
        <div className="me-stat">
          <strong>{trips.length}</strong>
          <span>份行程</span>
        </div>
        <div className="me-stat">
          <strong>{stats.days}</strong>
          <span>天在路上</span>
        </div>
        <div className="me-stat">
          <strong>{stats.dests}</strong>
          <span>个目的地</span>
        </div>
      </section>

      <section className="me-card">
        <div className="me-card-head">
          <div>
            <h2>我的偏好</h2>
            <p>只问一次，规划时直接传给 agent</p>
          </div>
          <button className="btn btn-sm btn-primary" type="button" onClick={() => void saveProfile()} disabled={saving || loading}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
        <div className="me-pref-group">
          <div className="me-pref-label">忌口</div>
          <div className="me-chips">
            {(options.diet || []).map(item => (
              <button
                key={item}
                type="button"
                className={`me-chip${diet.includes(item) ? ' active' : ''}`}
                onClick={() => toggle(diet, setDiet, item)}
                disabled={saving}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="me-pref-group">
          <div className="me-pref-label">爱吃什么</div>
          <div className="me-chips">
            {(options.taste || []).map(item => (
              <button
                key={item}
                type="button"
                className={`me-chip${taste.includes(item) ? ' active' : ''}`}
                onClick={() => toggle(taste, setTaste, item)}
                disabled={saving}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        {!profile?.exists && !loading && (
          <p className="me-muted">还没建档。选几项再保存，之后的餐厅推荐会按它来。</p>
        )}
      </section>

      <section className="me-card">
        <div className="me-card-head">
          <div>
            <h2>旅行历史</h2>
            <p>{trips.length ? `共 ${trips.length} 份，按出发日期倒序` : '还没有行程'}</p>
          </div>
          <Link className="btn btn-sm" to="/">全部行程</Link>
        </div>
        {loading ? (
          <div className="me-loading"><span className="spinner spinner-sm" /> 加载中…</div>
        ) : history.length === 0 ? (
          <div className="me-empty">
            <Icon name="compass" />
            <p>还没有旅行记录。按住下方「按住说」，一句话开始。</p>
            <button className="btn btn-sm btn-primary" type="button" onClick={() => void onNewTrip()} disabled={creating}>
              {creating ? '创建中…' : '新建行程'}
            </button>
          </div>
        ) : (
          <div className="me-history">
            {history.map(trip => (
              <button
                key={trip.tripId}
                type="button"
                className="me-history-row"
                onClick={() => navigate(`/t/${trip.tripId}`)}
              >
                <span className={`me-history-dot${trip.errorCount ? ' error' : trip.warningCount ? ' warn' : ''}`} />
                <span className="me-history-main">
                  <span className="me-history-title">{trip.title || '未命名行程'}</span>
                  <span className="me-history-meta">
                    {trip.dest || trip.origin || '目的地待定'}
                    {trip.dateStart ? ` · ${fmtDate(trip.dateStart)}${trip.dateEnd ? `–${fmtDate(trip.dateEnd)}` : ''}` : ''}
                    {trip.days ? ` · ${trip.days} 天` : ' · 待规划'}
                  </span>
                </span>
                <span className="me-history-side">
                  {trip.errorCount ? <span className="me-badge error">{trip.errorCount} 错误</span> : trip.done ? <span className="me-badge done">完成</span> : <span className="me-badge">{relativeTime(trip.updatedAt) || '—'}</span>}
                  <Icon name="chevronRight" />
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="me-card me-settings">
        <button className="me-row" type="button" onClick={openSettings}>
          <Icon name="settings" />
          <span>接入与设置</span>
          <em>模型 · 高德 · Tavily</em>
          <Icon name="chevronRight" />
        </button>
        <button className="me-row" type="button" onClick={toggleTheme}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          <span>外观</span>
          <em>{theme === 'dark' ? '深色' : '浅色'}</em>
          <Icon name="chevronRight" />
        </button>
        <Link className="me-row" to="/preview">
          <Icon name="miniProgram" />
          <span>多端预览</span>
          <em>App · 小程序 · 网页</em>
          <Icon name="chevronRight" />
        </Link>
        <div className="me-row static">
          <Icon name="info" />
          <span>运行环境</span>
          <em>{platformLabel[runtime.kind]}</em>
        </div>
      </section>

      <footer className="me-foot">
        Trace Planner · {runtime.version} · {new Date().getFullYear()}
      </footer>
    </div>
  )
}
