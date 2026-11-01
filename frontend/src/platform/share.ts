/**
 * 分享：一套调用，四种宿主。
 *
 * 优先级：
 *   App        → @capacitor/share 原生面板 → Web Share API → 复制链接
 *   小程序     → 原生分享页（用户在那里点「分享给好友」/ 右上角转发）
 *   微信浏览器 → 无法代码唤起转发，弹右上角引导 + 复制链接
 *   Web        → Web Share API → 复制链接
 */

import { runtime } from './runtime'
import { miniProgramNavigate } from './wechat'
import { copyText } from '../lib/toast'

export interface ShareTripInput {
  tripId: string
  title: string
  path?: string
  summary?: string
}

export type ShareMethod = 'native' | 'miniprogram' | 'guide' | 'copied' | 'cancelled' | 'unavailable'

export interface ShareResult {
  method: ShareMethod
  url?: string
  message?: string
}

function shareText(input: ShareTripInput): string {
  return input.summary ? `${input.title}\n${input.summary}` : input.title
}

/** 小程序里的原生分享页；参数尽量短，避免 navigateTo URL 超长。 */
export async function openMiniProgramShare(input: ShareTripInput): Promise<boolean> {
  const page = runtime.config.miniprogram?.sharePage || '/pages/share/index'
  const params = new URLSearchParams({
    tripId: input.tripId,
    title: input.title.slice(0, 32),
    path: input.path || `/t/${input.tripId}`,
  })
  return miniProgramNavigate(`${page}?${params.toString()}`)
}

export async function shareTrip(input: ShareTripInput): Promise<ShareResult> {
  const path = input.path || `/t/${input.tripId}`
  const url = runtime.shareUrl(path)

  // 1) 小程序：交给原生页，由它提供「分享给好友」按钮与右上角转发
  if (runtime.isMiniProgram && !runtime.isPreview) {
    if (await openMiniProgramShare(input)) {
      return { method: 'miniprogram', url }
    }
    return { method: 'guide', url, message: '请点右上角 ··· 转发给朋友' }
  }

  // 2) 微信内置浏览器：JSSDK 转发需要公众号签名，没接入时用标准引导
  if (runtime.isWeChatBrowser) {
    if (url) await copyText(url, '链接已复制，可粘贴给朋友')
    return { method: 'guide', url, message: '点右上角 ··· 分享给朋友' }
  }

  // 3) Capacitor 原生分享
  if (runtime.isNativeApp) {
    try {
      const { Share } = await import('@capacitor/share')
      const can = await Share.canShare()
      if (can.value) {
        await Share.share({
          title: input.title,
          text: shareText(input),
          url: url || undefined,
          dialogTitle: '分享行程',
        })
        return { method: 'native', url }
      }
    } catch (err) {
      // 用户取消不算错误
      if (err instanceof Error && /cancel/i.test(err.message)) return { method: 'cancelled' }
    }
  }

  // 4) Web Share API（Safari / Chrome Android / 部分桌面）
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title: input.title, text: shareText(input), url: url || undefined })
      return { method: 'native', url }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return { method: 'cancelled' }
    }
  }

  if (url) {
    await copyText(url, '分享链接已复制')
    return { method: 'copied', url }
  }

  return {
    method: 'unavailable',
    message: '当前环境拿不到可分享的链接：请在 VITE_PUBLIC_BASE_URL 配置对外域名',
  }
}
