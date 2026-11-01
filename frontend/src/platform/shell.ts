/**
 * 宿主壳能力：外链 / 原生导航 / 触感 / 软键盘 / App 生命周期 / 状态栏。
 *
 * 业务组件只调用这里，不直接碰 Capacitor 或 wx。
 */

import { runtime } from './runtime'
import { miniProgramNavigate, postToMiniProgram } from './wechat'
import { copyText, toast } from '../lib/toast'

export type OpenPlaceResult = 'native' | 'external' | 'copied' | 'failed'

export interface PlaceLink {
  name: string
  amapPoiId?: string | null
  lng?: number | null
  lat?: number | null
  mode?: 'car' | 'bus' | 'walk'
  transportMode?: string | null
  /** 浏览器 / App 里打开的高德 URI */
  webUrl: string
}

/** 打开任意外链：App 用内置浏览器，微信里新窗口，其他环境 window.open。 */
export function openExternalUrl(url: string): void {
  if (!url) return
  if (runtime.isNativeApp) {
    void import('@capacitor/browser')
      .then(({ Browser }) => Browser.open({ url }))
      .catch(() => {
        window.location.href = url
      })
    return
  }
  if (runtime.isMiniProgram && !runtime.isPreview) {
    // web-view 里 window.open 不可靠；交给原生页或复制
    void copyText(url, '链接已复制，可在浏览器打开')
    return
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened) window.location.href = url
}

/**
 * 打开地点导航。
 * 小程序里跳原生 `pages/place/index`（wx.openLocation，腾讯地图），
 * 其余宿主用高德统一 URI（移动端自动唤起高德 App）。
 */
export async function openPlaceLink(link: PlaceLink): Promise<OpenPlaceResult> {
  if (runtime.isMiniProgram && !runtime.isPreview) {
    const page = runtime.config.miniprogram?.placePage || '/pages/place/index'
    const params = new URLSearchParams({ name: link.name })
    if (link.lng != null && link.lat != null) {
      params.set('lng', String(link.lng))
      params.set('lat', String(link.lat))
    }
    if (link.amapPoiId) params.set('poiId', link.amapPoiId)
    if (link.mode) params.set('mode', link.mode)
    if (await miniProgramNavigate(`${page}?${params.toString()}`)) return 'native'
    if (link.webUrl) {
      void copyText(link.webUrl, '高德导航链接已复制')
      return 'copied'
    }
    return 'failed'
  }
  if (!runtime.features.externalNavigation) {
    void copyText(link.webUrl || link.name, '导航链接已复制')
    return 'copied'
  }
  openExternalUrl(link.webUrl)
  return 'external'
}

/** 轻触反馈：App 原生震动，浏览器尝试 Vibration API，其余安静。 */
export function hapticTap(kind: 'light' | 'medium' = 'light'): void {
  if (!runtime.features.haptics) return
  if (runtime.isNativeApp) {
    void import('@capacitor/haptics')
      .then(({ Haptics, ImpactStyle }) =>
        Haptics.impact({ style: kind === 'light' ? ImpactStyle.Light : ImpactStyle.Medium }),
      )
      .catch(() => undefined)
    return
  }
  try {
    window.navigator.vibrate?.(kind === 'light' ? 8 : 16)
  } catch {
    /* unsupported */
  }
}

/* ------------------------------------------------------------------ */
/* 软键盘：把可视视口和布局视口的差写成 --kb-inset，移动端用它压缩外壳高度。 */
/* ------------------------------------------------------------------ */

let viewportBound = false

function bindVisualViewport(): void {
  if (viewportBound || typeof window === 'undefined') return
  viewportBound = true
  const root = document.documentElement
  const vv = window.visualViewport
  let raf = 0

  const apply = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const viewportHeight = vv?.height ?? window.innerHeight
      // 只把「明显是键盘」的差值算进去，忽略地址栏收缩等 80px 级变化
      const raw = window.innerHeight - viewportHeight
      const inset = raw > 120 ? Math.round(raw) : 0
      root.style.setProperty('--kb-inset', `${inset}px`)
      root.classList.toggle('keyboard-open', inset > 0)
    })
  }

  window.addEventListener('resize', apply, { passive: true })
  vv?.addEventListener('resize', apply, { passive: true })
  vv?.addEventListener('scroll', apply, { passive: true })
  apply()
}

/* ------------------------------------------------------------------ */
/* Capacitor 原生壳：状态栏、返回键、生命周期、Splash。               */
/* ------------------------------------------------------------------ */

let nativeBound = false

async function applyNativeStatusBar(): Promise<void> {
  if (!runtime.isNativeApp) return
  try {
    const mod = await import('@capacitor/status-bar')
    const dark = document.documentElement.dataset.theme === 'dark'
    await mod.StatusBar.setStyle({ style: dark ? mod.Style.Dark : mod.Style.Light })
    await mod.StatusBar.setBackgroundColor({ color: dark ? '#0E1418' : '#FFFFFF' })
  } catch {
    /* plugin missing in web preview */
  }
}

async function bindNativeShell(): Promise<void> {
  if (!runtime.isNativeApp || nativeBound || typeof window === 'undefined') return
  nativeBound = true
  bindVisualViewport()
  try {
    const { App: CapApp } = await import('@capacitor/app')
    void CapApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack || window.history.length > 1) window.history.back()
      else void CapApp.exitApp()
    })
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      document.dispatchEvent(new CustomEvent('tp:appstate', { detail: { isActive } }))
    })
  } catch {
    /* web */
  }
  try {
    const mod = await import('@capacitor/status-bar')
    await mod.StatusBar.setOverlaysWebView({ overlay: false })
    await applyNativeStatusBar()
    const observer = new MutationObserver(() => void applyNativeStatusBar())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  } catch {
    /* ignore */
  }
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen')
    await SplashScreen.hide()
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* PWA：生产环境注册 Service Worker；微信/开发环境不注册。             */
/* ------------------------------------------------------------------ */

function registerServiceWorker(): void {
  if (!import.meta.env.PROD || runtime.isWeChat || runtime.isNativeApp) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 静态资源路径被改写时允许静默失败 */
    })
  })
}

/** 在 App/浏览器根组件里调用一次。 */
export function initPlatformShell(): void {
  bindVisualViewport()
  void bindNativeShell()
  registerServiceWorker()
}

/** 供非 React 模块（如 store 初始化）判断是否需要走原生键盘处理。 */
export function isKeyboardOpen(): boolean {
  return document.documentElement.classList.contains('keyboard-open')
}

/** 预留：小程序里把行程同步给宿主，原生分享兜底。 */
export function notifyMiniProgramTrip(payload: { tripId: string; title: string; path?: string }): void {
  if (!runtime.isMiniProgram || runtime.isPreview) return
  void postToMiniProgram({ type: 'trip', ...payload })
}

export function showPlatformToast(message: string): void {
  toast(message, 'info')
}
