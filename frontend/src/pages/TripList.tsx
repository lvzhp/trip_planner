import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useListStore } from '../stores/listStore'
import { useAppStore } from '../stores/appStore'
import { useUiStore } from '../stores/uiStore'
import { fmtDate, relativeTime } from '../lib/format'
import { Icon } from '../lib/icons'
import { renderThumbSvg } from '../map/MapCanvas'
import { toast } from '../lib/toast'

const DAY_COLORS = [
  'hsl(152,55%,33%)',
  'hsl(200,62%,42%)',
  'hsl(262,52%,50%)',
  'hsl(326,55%,46%)',
  'hsl(14,68%,48%)',
  'hsl(40,78%,42%)',
  'hsl(76,52%,36%)',
  'hsl(110,45%,36%)',
  'hsl(172,52%,34%)',
  'hsl(216,58%,46%)',
  'hsl(284,46%,48%)',
  'hsl(344,58%,46%)',
]

export function TripList() {
  const navigate = useNavigate()
  const trips = useListStore(s => s.trips)
  const loading = useListStore(s => s.loading)
  const error = useListStore(s => s.error)
  const fetchTrips = useListStore(s => s.fetchTrips)
  const createTrip = useListStore(s => s.createTrip)
  const loadConfig = useAppStore(s => s.loadConfig)
  const theme = useUiStore(s => s.theme)
  const toggleTheme = useUiStore(s => s.toggleTheme)
  const openSettings = useUiStore(s => s.openSettings)
  const config = useAppStore(s => s.config)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    document.body.classList.add('list-page')
    document.body.classList.remove('workbench-page')
    void fetchTrips()
    void loadConfig()
    return () => document.body.classList.remove('list-page')
  }, [fetchTrips, loadConfig])

  const onNew = async () => {
    setCreating(true)
    const id = await createTrip('未命名行程')
    setCreating(false)
    if (id) navigate(`/t/${id}`)
    else toast('创建行程失败', 'xCircle')
  }

  return (
    <div className="trip-list-page">
      <header className="list-topbar">
        <span className="topbar-brand">
          <span className="logo"><Icon name="logo" /></span>
          Trace Planner
        </span>
        <span className="list-tagline">行程即文档 · 对话与地图是它的两个视图</span>
        <span className="spacer" />
        <button className={`mode-pill ${config?.agentMode === 'real' ? 'real' : 'demo'}`} type="button" onClick={openSettings} title="接入真实模型/高德/Tavily">
          <span className="mode-dot" /> {config?.agentMode === 'real' ? '真实模式' : '演示模式'}
        </button>
        <button className="btn btn-sm" type="button" onClick={openSettings}>
          <Icon name="settings" /> 接入配置
        </button>
        <button className="icon-btn" type="button" aria-label="切换深色模式" onClick={toggleTheme}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <Link className="icon-btn desktop-only" to="/me" aria-label="我的">
          <Icon name="user" />
        </Link>
        <Link className="btn btn-sm desktop-only list-secondary" to="/preview"><Icon name="miniProgram" /> 多端预览</Link>
        <Link className="btn btn-sm desktop-only list-secondary" to="/spec">设计规范</Link>
      </header>

      <main className="list-main">
        <div className="list-head">
          <div>
            <h1>我的行程</h1>
            <p className="list-sub">单用户本地模式 · 所有行程由服务端持有，可随时回到任意版本</p>
          </div>
          <span className="count">共 {trips.length} 个行程</span>
        </div>

        {loading && trips.length === 0 && (
          <div className="trip-grid">
            {[0, 1, 2].map(i => <div className="trip-card-skeleton" key={i}><i /><i /><i /></div>)}
          </div>
        )}

        {error && (
          <div className="list-error">
            <Icon name="xCircle" /> {error}
            <button className="btn btn-sm" type="button" onClick={() => fetchTrips()}>重试</button>
          </div>
        )}

        {!loading && !error && (
          <div className="trip-grid">
            {trips.map(trip => {
              const points = (trip.routePoints || []) as [number, number][]
              const thumb = renderThumbSvg(points, DAY_COLORS)
              const conflictBadge = trip.errorCount ? (
                <span className="badge badge-error">
                  <Icon name="warn" /> {trip.errorCount} 错误{trip.warningCount ? ` · ${trip.warningCount} 警告` : ''}
                </span>
              ) : trip.warningCount ? (
                <span className="badge badge-warning">
                  <Icon name="warn" /> {trip.warningCount} 警告
                </span>
              ) : trip.done ? (
                <span className="chip" style={{ color: 'var(--success)' }}>
                  <Icon name="checkCircle" /> 已完成
                </span>
              ) : (
                <span className="chip"><Icon name="check" /> 校验通过</span>
              )
              return (
                <Link className="trip-card-link" to={`/t/${trip.tripId}`} key={trip.tripId} aria-label={`打开行程 ${trip.title}`}>
                  <div className="trip-thumb">
                    <svg className="thumb" role="img" aria-label={`${trip.dest || trip.title} 路线缩略图`} viewBox="0 0 320 150" dangerouslySetInnerHTML={{ __html: thumb }} />
                    <span className="tt-version">v{trip.version}</span>
                  </div>
                  <div className="trip-card-body">
                    <h3>{trip.title}</h3>
                    <div className="trip-card-meta">
                      <span><Icon name="map" /> {trip.dest || trip.origin || '目的地待定'}</span>
                      <span>
                        <Icon name="calendar" />{' '}
                        {trip.dateStart ? `${fmtDate(trip.dateStart)} – ${fmtDate(trip.dateEnd)}` : '日期待定'} · {trip.days} 天
                      </span>
                      <span>
                        <Icon name={trip.transportMode === 'train' ? 'train' : trip.transportMode === 'flight' ? 'flight' : 'car'} />{' '}
                        {trip.transportMode === 'train' ? '火车' : trip.transportMode === 'flight' ? '飞机' : trip.transportMode === 'self_drive' ? '自驾' : '交通待定'}
                      </span>
                    </div>
                    <div className="trip-card-foot">
                      <span className="updated">更新于 {relativeTime(trip.updatedAt) || '—'}</span>
                      <span className="conflicts">{conflictBadge}</span>
                    </div>
                  </div>
                </Link>
              )
            })}

            <button className="new-trip-card" type="button" onClick={onNew} disabled={creating}>
              <span className="plus-circle"><Icon name="plus" /></span>
              {creating ? '正在创建…' : '新建行程'}
              <span style={{ fontSize: 'var(--fs-12)', fontWeight: 500, color: 'var(--text-faint)' }}>
                从一句话开始，AI 帮你排全程
              </span>
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
