/**
 * 微信 JSSDK（仅小程序 web-view 需要）。
 *
 * web-view 里的 H5 不能调 wx.* 原生 API，只能通过 `wx.miniProgram.*` 与宿主通信：
 *   navigateTo  跳到原生页面（地图导航 / 分享卡片）
 *   postMessage 把当前行程同步给小程序页，分享时作为 onShareAppMessage 的兜底
 *
 * JSSDK 只在真·小程序里加载；桌面预览（tp_preview=1）不加载，避免本地验收时
 * 因为网络/域名问题卡住首屏。所有调用都会超时降级，不允许阻塞主流程。
 */

import { runtime } from './runtime'

const JSSDK_URL = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'
const JSSDK_TIMEOUT = 3000

let jssdkPromise: Promise<WechatMiniProgramApi | null> | null = null

interface WechatMiniProgramApi {
  navigateTo?: (opts: { url: string; success?: () => void; fail?: () => void }) => void
  reLaunch?: (opts: { url: string }) => void
  postMessage?: (opts: { data: Record<string, unknown> }) => void
  getEnv?: (cb: (res: { miniprogram: boolean }) => void) => void
}

/** 等 window.wx 上的 miniProgram 能力就绪（最多 3s）。 */
export function loadWechatJssdk(): Promise<WechatMiniProgramApi | null> {
  if (!runtime.isMiniProgram || runtime.isPreview) return Promise.resolve(null)
  const wx = (window as { wx?: { miniProgram?: WechatMiniProgramApi } }).wx
  if (wx?.miniProgram) return Promise.resolve(wx.miniProgram)
  if (jssdkPromise) return jssdkPromise

  jssdkPromise = new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(((window as { wx?: { miniProgram?: WechatMiniProgramApi } }).wx?.miniProgram) || null)
    }
    const script = document.createElement('script')
    script.src = JSSDK_URL
    script.async = true
    script.onload = finish
    script.onerror = finish
    document.head.appendChild(script)
    window.setTimeout(finish, JSSDK_TIMEOUT)
  })
  return jssdkPromise
}

function normalizeMiniProgramUrl(url: string): string {
  if (!url) return url
  if (/^https?:\/\//i.test(url)) return url
  return url.startsWith('/') ? url : `/${url}`
}

/** 从 web-view 跳到小程序原生页；失败返回 false，由调用方降级。 */
export async function miniProgramNavigate(url: string): Promise<boolean> {
  const api = await loadWechatJssdk()
  const navigateTo = api?.navigateTo
  if (!navigateTo) return false
  return new Promise(resolve => {
    try {
      navigateTo({
        url: normalizeMiniProgramUrl(url),
        success: () => resolve(true),
        fail: () => resolve(false),
      })
    } catch {
      resolve(false)
    }
  })
}

/** 把当前行程/分享信息交给小程序宿主（会在分享、后退等时机送达）。 */
export async function postToMiniProgram(data: Record<string, unknown>): Promise<void> {
  const api = await loadWechatJssdk()
  try {
    api?.postMessage?.({ data })
  } catch {
    /* non-blocking */
  }
}

export async function getWechatEnv(): Promise<'miniprogram' | 'browser' | null> {
  if (!runtime.isWeChat) return null
  if (runtime.isMiniProgram) return 'miniprogram'
  const api = (window as { wx?: { miniProgram?: WechatMiniProgramApi } }).wx?.miniProgram
  if (!api?.getEnv) return null
  return new Promise(resolve => {
    try {
      api.getEnv?.(res => resolve(res.miniprogram ? 'miniprogram' : 'browser'))
      window.setTimeout(() => resolve(null), 800)
    } catch {
      resolve(null)
    }
  })
}
