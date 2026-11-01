/**
 * 多端运行时（docs/08-multi-platform.md）。
 *
 * 同一份前端代码要跑在四个宿主里：
 *   web                 桌面/手机浏览器、PWA
 *   wechat-browser      微信内置浏览器（公众号 H5）
 *   wechat-miniprogram  微信小程序 <web-view> 内
 *   app                 Capacitor 原生壳（iOS / Android）
 *
 * 这里只做「同步、无副作用」的环境判定与能力表。所有会导致页面跳走、
 * 打开原生能力的行为都放在 share.ts / shell.ts 里，避免业务组件到处写 UA 判断。
 *
 * 小程序壳会在 URL 上带 `tp_platform=miniprogram`：web-view 不允许注入脚本，
 * 而 JSSDK 的 `__wxjs_environment` 是异步就绪的，URL 参数是最可靠的同步信号。
 * 桌面预览页用同样的参数模拟宿主（tp_preview=1），用于本地验收。
 */

import { Capacitor } from '@capacitor/core'

export type PlatformKind = 'web' | 'wechat-browser' | 'wechat-miniprogram' | 'app'
export type RouterMode = 'browser' | 'hash'

export interface PlatformFeatures {
  /** 原生分享面板 / 微信转发 */
  share?: boolean
  /** 导出长图（移动端改为预览长按保存） */
  exportImage?: boolean
  /** 外部导航（高德 / 腾讯地图） */
  externalNavigation?: boolean
  /** 轻触反馈 */
  haptics?: boolean
  /** 页面下拉刷新（浏览器壳） */
  pullToRefresh?: boolean
}

export interface TpRuntimeConfig {
  platform?: 'auto' | PlatformKind
  /** API 根地址；App 包必须显式配置成 https://your-api.example.com/api */
  apiBase?: string
  /** 对外可访问的 H5 站点根地址，用于分享链接；App 包必须显式配置 */
  publicBaseUrl?: string
  /** H5 站点使用哪种路由；默认 web=browser，app/miniprogram=hash */
  router?: RouterMode
  /** 分享出去的网页链接使用哪种路由；默认 browser */
  shareRouter?: RouterMode
  appVersion?: string
  features?: PlatformFeatures
  miniprogram?: {
    /** 原生导航页，默认 /pages/place/index */
    placePage?: string
    /** 原生分享页，默认 /pages/share/index */
    sharePage?: string
  }
}

declare global {
  interface Window {
    __TP_CONFIG__?: TpRuntimeConfig
    __wxjs_environment?: string
    wx?: any
    Capacitor?: {
      isNativePlatform?: () => boolean
      getPlatform?: () => string
    }
  }
}

const CONFIG: TpRuntimeConfig = (typeof window !== 'undefined' && window.__TP_CONFIG__) || {}

function readParams(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams()
  return new URLSearchParams(window.location.search || '')
}

const PARAMS = readParams()
const PLATFORM_OVERRIDE = PARAMS.get('tp_platform')
const IS_PREVIEW = PARAMS.get('tp_preview') === '1'

const PLATFORM_VALUES: PlatformKind[] = ['web', 'app', 'wechat-browser', 'wechat-miniprogram']

/** 允许 URL / 构建配置使用短名：miniprogram / weapp / wechat。 */
const PLATFORM_ALIASES: Record<string, PlatformKind> = {
  miniprogram: 'wechat-miniprogram',
  weapp: 'wechat-miniprogram',
  mp: 'wechat-miniprogram',
  wechat: 'wechat-browser',
  h5: 'web',
}

function normalizePlatform(value: string | undefined | null): PlatformKind | null {
  if (!value) return null
  const raw = value.trim()
  if ((PLATFORM_VALUES as string[]).includes(raw)) return raw as PlatformKind
  return PLATFORM_ALIASES[raw] || null
}

function detectKind(): PlatformKind {
  const overrideKind = normalizePlatform(PLATFORM_OVERRIDE)
  if (overrideKind) return overrideKind
  const configuredKind = normalizePlatform(CONFIG.platform)
  if (configuredKind) return configuredKind
  if (typeof window === 'undefined') return 'web'
  if (Capacitor.isNativePlatform() || window.Capacitor?.isNativePlatform?.()) return 'app'
  if (window.__wxjs_environment === 'miniprogram') return 'wechat-miniprogram'
  if (/MicroMessenger/i.test(window.navigator.userAgent)) return 'wechat-browser'
  return 'web'
}

const KIND = detectKind()

function normalizeBase(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '')
  if (trimmed.startsWith('/')) return trimmed.replace(/\/+$/, '') || '/'
  return trimmed.replace(/\/+$/, '')
}

function detectApiBase(): string {
  const configured = CONFIG.apiBase || (import.meta.env.VITE_API_BASE as string | undefined) || '/api'
  const normalized = normalizeBase(configured)
  return normalized || '/api'
}

function detectPublicBaseUrl(): string {
  const configured = CONFIG.publicBaseUrl || (import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined)
  if (configured) return normalizeBase(configured)
  if (KIND === 'app') {
    // Capacitor 内部地址（capacitor://localhost / https://localhost）不能拿去分享。
    return ''
  }
  if (typeof window === 'undefined') return ''
  const basePath = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
  return `${window.location.origin}${basePath === '/' ? '' : basePath}`
}

function detectRouterMode(): RouterMode {
  const configured =
    CONFIG.router ||
    (import.meta.env.VITE_ROUTER_MODE as RouterMode | undefined) ||
    (KIND === 'app' || KIND === 'wechat-miniprogram' ? 'hash' : 'browser')
  return configured === 'hash' ? 'hash' : 'browser'
}

const FEATURES: Required<PlatformFeatures> = {
  share: true,
  exportImage: true,
  externalNavigation: true,
  haptics: true,
  pullToRefresh: false,
  ...(CONFIG.features || {}),
}

export const runtime = {
  kind: KIND,
  config: CONFIG,
  isPreview: IS_PREVIEW,
  isWeChat: KIND === 'wechat-browser' || KIND === 'wechat-miniprogram',
  isMiniProgram: KIND === 'wechat-miniprogram',
  isWeChatBrowser: KIND === 'wechat-browser',
  isNativeApp: KIND === 'app',
  /** App / 小程序：移动端外壳的行为要更「像原生」 */
  isMobileShell: KIND === 'app' || KIND === 'wechat-miniprogram',
  isStandalone:
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true),
  isIOS:
    typeof window !== 'undefined' &&
    (/iPad|iPhone|iPod/.test(window.navigator.userAgent) ||
      (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1)),
  apiBase: detectApiBase(),
  publicBaseUrl: detectPublicBaseUrl(),
  routerMode: detectRouterMode(),
  features: FEATURES,
  params: PARAMS,
  version: CONFIG.appVersion || '0.1.0',

  /** 分享链接是否可用（App 包没配 publicBaseUrl 时会不可用） */
  get canShareLink(): boolean {
    return Boolean(this.publicBaseUrl)
  },

  /** 对外分享 / 复制用的 URL；路由默认用 web 的 browser 模式 */
  shareUrl(path: string): string {
    if (!this.publicBaseUrl) return ''
    const clean = path.startsWith('/') ? path : `/${path}`
    const shareRouter = CONFIG.shareRouter || 'browser'
    return shareRouter === 'hash'
      ? `${this.publicBaseUrl}/#${clean}`
      : `${this.publicBaseUrl}${clean}`
  },
} as const

export type Runtime = typeof runtime

export const platformLabel: Record<PlatformKind, string> = {
  web: '网页 / PWA',
  app: '手机 App',
  'wechat-browser': '微信浏览器',
  'wechat-miniprogram': '微信小程序',
}

/** 同步设置根节点标记（首屏渲染前调用，避免移动端样式闪一下） */
export function applyPlatformChrome(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.platform = runtime.kind
  root.classList.toggle('platform-app', runtime.kind === 'app')
  root.classList.toggle('platform-weapp', runtime.kind === 'wechat-miniprogram')
  root.classList.toggle('platform-wechat', runtime.isWeChat)
  root.classList.toggle('platform-preview', runtime.isPreview)
  root.classList.toggle('platform-standalone', runtime.isStandalone)
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = '#1D6F5C'
}

export function syncThemeColor(color: string): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = color
}
