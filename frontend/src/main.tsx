import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initThemeFromStore } from './stores/uiStore'
import { applyPlatformChrome } from './platform/runtime'
import { initPlatformShell } from './platform/shell'
import 'leaflet/dist/leaflet.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'
import './styles/platform.css'
import './styles/mobile.css'
import './styles/mindtrip.css'

// 先标出宿主（web / app / 微信浏览器 / 小程序 web-view），避免移动端样式闪一下
applyPlatformChrome()
initThemeFromStore()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// 软键盘、状态栏、返回键、PWA 注册（非 React 生命周期，只需一次）
initPlatformShell()
