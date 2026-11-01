import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { MobilePlanSheet } from './MobilePlanSheet'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'

type TabId = 'map' | 'trips' | 'plan' | 'me'

/**
 * 移动端全局底部导航。
 *
 * 地图 / 行程 / 按住说 / 我的 —— 只在移动壳 + 可编辑行程相关页面出现。
 * 分享页（/s）、设计规范、预览页不显示，避免给只读访问者误导入口。
 * 桌面端由 CSS 隐藏（display:none），页面布局保持原双栏。
 */
export function MobileTabBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const trip = useTripStore(s => s.trip)
  const [planOpen, setPlanOpen] = useState(false)
  const path = location.pathname

  const hidden = path === '/spec' || path === '/preview' || path.startsWith('/s/')
  const isMap = /^\/t\/[^/]+\/?$/.test(path)
  const isChat = /^\/t\/[^/]+\/chat\/?$/.test(path)
  const isMe = path === '/me'
  const isTrips = path === '/'
  const visible = !hidden && (isMap || isChat || isMe || isTrips)

  useEffect(() => {
    document.body.classList.toggle('has-mobile-tabbar', visible)
    return () => document.body.classList.remove('has-mobile-tabbar')
  }, [visible])

  useEffect(() => {
    setPlanOpen(false)
  }, [path])

  if (!visible) return null

  const active: TabId = isChat ? 'plan' : isMap ? 'map' : isMe ? 'me' : 'trips'
  const tripId = trip?.tripId

  const goMap = () => {
    if (isMap) {
      // 已经在地图页：再点一次地图 = 收起行程面板，看完整地图
      useUiStore.getState().setMobileSheet(0)
      return
    }
    useUiStore.getState().setMobileSheet(0)
    if (tripId) navigate(`/t/${tripId}`)
    else {
      toast('先从行程列表选一份行程', 'info')
      navigate('/')
    }
  }

  return (
    <>
      <nav className="mobile-tabbar" aria-label="主导航">
        <button
          type="button"
          className={`mtab${active === 'map' ? ' active' : ''}`}
          aria-current={active === 'map' ? 'page' : undefined}
          onClick={goMap}
        >
          <Icon name="map" />
          <span>地图</span>
        </button>
        <button
          type="button"
          className={`mtab${active === 'trips' ? ' active' : ''}`}
          aria-current={active === 'trips' ? 'page' : undefined}
          onClick={() => navigate('/')}
        >
          <Icon name="route" />
          <span>行程</span>
        </button>
        <button
          type="button"
          className={`mtab mtab-say${planOpen || active === 'plan' ? ' active' : ''}`}
          aria-label="按住说话，开始规划"
          onPointerDown={event => {
            event.preventDefault()
            setPlanOpen(true)
          }}
          onClick={() => setPlanOpen(true)}
        >
          <span className="say-orb">
            <Icon name="mic" />
          </span>
          <span>按住说</span>
        </button>
        <button
          type="button"
          className={`mtab${active === 'me' ? ' active' : ''}`}
          aria-current={active === 'me' ? 'page' : undefined}
          onClick={() => navigate('/me')}
        >
          <Icon name="user" />
          <span>我的</span>
        </button>
      </nav>
      <MobilePlanSheet open={planOpen} onClose={() => setPlanOpen(false)} />
    </>
  )
}
