import { Component, type ReactNode } from 'react'
import { BrowserRouter, HashRouter, Link, Route, Routes } from 'react-router-dom'
import { TripList } from './pages/TripList'
import { Workbench } from './pages/Workbench'
import { Spec } from './pages/Spec'
import { Preview } from './pages/Preview'
import { Me } from './pages/Me'
import { SettingsDialog } from './components/SettingsDialog'
import { ProfileOnboarding } from './components/ProfileOnboarding'
import { ShareGuide } from './components/ShareGuide'
import { MobileTabBar } from './components/MobileTabBar'
import { runtime } from './platform/runtime'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error(error)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="wb-error" style={{ minHeight: '100dvh' }}>
          <h2>页面出错了</h2>
          <p>{this.state.error.message}</p>
          <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      )
    }
    return this.props.children
  }
}

function NotFound() {
  return (
    <div className="wb-error" style={{ minHeight: '100dvh' }}>
      <h2>页面不存在</h2>
      <p>这个链接没有对应的页面。</p>
      <Link className="btn btn-primary" to="/">返回行程列表</Link>
    </div>
  )
}

/**
 * 路由宿主：
 * - 普通 H5 / 后端托管：BrowserRouter（分享链接 /t/xxx 更友好）
 * - App 包 / 小程序 web-view：HashRouter（capacitor://localhost 与静态托管都能直接刷新）
 */
function AppRouter({ children }: { children: ReactNode }) {
  if (runtime.routerMode === 'hash') return <HashRouter>{children}</HashRouter>
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
  return <BrowserRouter basename={base && base !== '/' ? base : undefined}>{children}</BrowserRouter>
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppRouter>
        <Routes>
          <Route path="/" element={<TripList />} />
          <Route path="/t/:tripId" element={<Workbench />} />
          <Route path="/t/:tripId/chat" element={<Workbench chatOnly />} />
          <Route path="/s/:tripId" element={<Workbench readonly />} />
          <Route path="/me" element={<Me />} />
          <Route path="/spec" element={<Spec />} />
          <Route path="/preview" element={<Preview />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <SettingsDialog />
        <ProfileOnboarding />
        <ShareGuide />
        <MobileTabBar />
      </AppRouter>
    </ErrorBoundary>
  )
}
