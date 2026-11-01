import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { TripSummary } from '../types'
import { Icon } from '../lib/icons'
import '../styles/preview.css'

type Mode = 'app' | 'miniprogram' | 'web'

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'app', label: '手机 App', hint: 'Capacitor 原生壳 · 安全区 / 原生分享' },
  { id: 'miniprogram', label: '微信小程序', hint: 'web-view 内嵌 · 原生导航 / 转发' },
  { id: 'web', label: '网页 / PWA', hint: '浏览器 / 添加到主屏幕' },
]

function framePath(mode: Mode, tripId: string): string {
  const base = import.meta.env.BASE_URL || '/'
  if (mode === 'web') return `${base}t/${tripId}?tp_preview=1`
  // App / 小程序宿主：HashRouter + URL 上声明平台，模拟 web-view 的真实入口
  return `${base}?tp_platform=${mode}&tp_preview=1#/t/${tripId}`
}

export function Preview() {
  const [mode, setMode] = useState<Mode>('app')
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [tripId, setTripId] = useState('')
  const [nonce, setNonce] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    document.body.classList.add('preview-page-body')
    document.title = '多端预览 · Trace Planner'
    void api
      .trips()
      .then(data => {
        const list = data.trips || []
        setTrips(list)
        const preferred =
          list.find(t => t.days > 0 && t.tripId.startsWith('trip_'))?.tripId ||
          list.find(t => t.days > 0)?.tripId ||
          list[0]?.tripId ||
          ''
        setTripId(current => current || preferred)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
    return () => {
      document.body.classList.remove('preview-page-body')
      document.title = 'Trace Planner'
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '1') setMode('app')
      if (event.key === '2') setMode('miniprogram')
      if (event.key === '3') setMode('web')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const active = MODES.find(m => m.id === mode) || MODES[0]
  const src = tripId ? framePath(mode, tripId) : ''

  return (
    <div className="preview-page">
      <header className="preview-head">
        <Link className="preview-brand" to="/">
          <span className="logo"><Icon name="logo" /></span>
          <span>Trace Planner</span>
        </Link>
        <div className="preview-head-main">
          <h1>多端预览</h1>
          <p>同一份 H5 核心，三种宿主。快捷键 1 / 2 / 3 切换。</p>
        </div>
        <Link className="btn btn-sm" to="/">
          <Icon name="chevronLeft" /> 返回行程
        </Link>
      </header>

      <section className="preview-toolbar" aria-label="选择宿主">
        <div className="preview-modes" role="tablist">
          {MODES.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={mode === item.id}
              className={mode === item.id ? 'active' : ''}
              onClick={() => setMode(item.id)}
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>
        <div className="preview-actions">
          <label className="preview-select">
            <span>行程</span>
            <select value={tripId} onChange={event => setTripId(event.target.value)}>
              {trips.length === 0 && <option value="">加载中…</option>}
              {trips.map(trip => (
                <option key={trip.tripId} value={trip.tripId}>
                  {trip.title} · {trip.days} 天
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-sm" type="button" onClick={() => setNonce(v => v + 1)}>
            <Icon name="history" /> 重载
          </button>
          {src && (
            <a className="btn btn-sm btn-primary" href={src} target="_blank" rel="noreferrer">
              <Icon name="arrowUpRight" /> 新窗口打开
            </a>
          )}
        </div>
      </section>

      {error && <div className="preview-error">{error}</div>}

      <section className="preview-stage">
        <div className={`device device-${mode}`}>
          <div className="device-shell">
            <div className="device-screen">
              {mode === 'app' && <AppStatusBar />}
              {mode === 'miniprogram' && <AppStatusBar wechat />}
              {mode === 'miniprogram' && <WechatNavBar />}
              {mode === 'web' && <BrowserBar src={src} />}
              {src ? (
                <iframe
                  key={`${mode}-${tripId}-${nonce}`}
                  className="device-frame"
                  title={active.label}
                  src={src}
                  allow="clipboard-read; clipboard-write; geolocation"
                />
              ) : (
                <div className="device-empty">
                  <span className="spinner" />
                  <span>正在载入行程…</span>
                </div>
              )}
              {(mode === 'app' || mode === 'miniprogram') && <div className="device-home-indicator" />}
            </div>
          </div>
          <div className="device-caption">
            <strong>{active.label}</strong>
            <span>{active.hint}</span>
          </div>
        </div>

        <aside className="preview-notes">
          <h2>这套前端怎么同时跑三端</h2>
          <ol>
            <li>
              <strong>共享核心</strong>：React + Zustand 的业务层与视觉层只有一份，
              <code>src/platform/</code> 负责探测宿主并抽象差异。
            </li>
            <li>
              <strong>App</strong>：Capacitor 包 <code>dist/</code>，用 <code>@capacitor/share</code>、
              <code>status-bar</code>、<code>app</code> 提供原生分享、状态栏和 Android 返回键。
            </li>
            <li>
              <strong>小程序</strong>：<code>miniprogram/</code> 原生壳用 <code>&lt;web-view&gt;</code> 载入
              H5；导航跳 <code>pages/place</code>（wx.openLocation），分享跳 <code>pages/share</code>。
            </li>
            <li>
              <strong>移动端外壳</strong>：底部四个 Tab（地图 / 行程 / 按住说 / 我的）。地图页默认看地图，
              上拉出现当天行程；选中某天只画当天路线，点「全部」才看全程。中间「按住说」打开语音/文字规划面板。
            </li>
            <li>
              <strong>降级</strong>：微信里复制链接 + 右上角转发引导；移动端导出改成图片预览长按保存；
              不支持 Web Speech 的宿主自动改成键盘输入。
            </li>
          </ol>
          <div className="preview-note-card">
            <Icon name="info" />
            <div>
              <strong>这里只是桌面沙箱预览</strong>
              <p>
                真机请用局域网地址；小程序请用微信开发者工具打开 <code>miniprogram/</code>。
                细节见 <code>docs/08-multi-platform.md</code>。
              </p>
            </div>
          </div>
          <div className="preview-links">
            <Link className="btn btn-sm" to="/spec">设计规范</Link>
            <Link className="btn btn-sm" to="/">行程列表</Link>
          </div>
        </aside>
      </section>
    </div>
  )
}

function AppStatusBar({ wechat = false }: { wechat?: boolean }) {
  return (
    <div className={`app-statusbar${wechat ? ' wechat-statusbar' : ''}`} aria-hidden="true">
      <span className="status-time">9:41</span>
      <span className="status-icons">
        <i className="sig" />
        <i className="wifi" />
        <i className="battery" />
      </span>
    </div>
  )
}

function WechatNavBar() {
  return (
    <div className="wechat-navbar" aria-hidden="true">
      <span className="wn-back">‹</span>
      <span className="wn-title">Trace Planner</span>
      <span className="wn-capsule">
        <span className="wn-dots">•••</span>
        <span className="wn-sep" />
        <span className="wn-circle">◎</span>
      </span>
    </div>
  )
}

function BrowserBar({ src }: { src: string }) {
  return (
    <div className="browser-bar" aria-hidden="true">
      <span className="br-dots"><i /><i /><i /></span>
      <span className="br-url">{src ? `traceplanner.app${src.replace(/^https?:\/\/[^/]+/, '')}` : 'traceplanner.app'}</span>
    </div>
  )
}
