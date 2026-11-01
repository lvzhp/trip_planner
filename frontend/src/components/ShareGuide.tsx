import { runtime } from '../platform/runtime'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { copyText } from '../lib/toast'
import { Icon } from '../lib/icons'

/**
 * 微信内转发引导。
 *
 * 微信内置浏览器 / 小程序 web-view 都不允许网页直接唤起「发送给朋友」，
 * 唯一可靠路径是让用户点右上角胶囊菜单。这里提供明确的视觉指向 + 一键复制链接。
 */
export function ShareGuide() {
  const open = useUiStore(s => s.shareGuideOpen)
  const close = useUiStore(s => s.closeShareGuide)
  const trip = useTripStore(s => s.trip)
  if (!open) return null

  const url = trip ? runtime.shareUrl(`/s/${trip.tripId}`) : ''
  const isWeChat = runtime.isWeChat

  return (
    <div className="share-guide-scrim" role="dialog" aria-modal="true" aria-label="分享行程" onClick={close}>
      <div className="share-guide-arrow" aria-hidden="true">
        <span className="sg-line" />
        <span className="sg-dot">···</span>
      </div>
      <div className="share-guide-card" onClick={event => event.stopPropagation()}>
        <div className="sg-title">
          <Icon name="share" /> {isWeChat ? '分享到微信' : '分享这份行程'}
        </div>
        <p className="sg-body">
          {isWeChat
            ? '点右上角「···」，选择「发送给朋友」或「分享到朋友圈」，对方打开就是只读行程页。'
            : '把下面的只读链接发给朋友，对方无需登录即可查看地图与行程卡片。'}
        </p>
        {url ? (
          <div className="sg-link">
            <span className="od-truncate">{url}</span>
            <button className="btn btn-sm" type="button" onClick={() => void copyText(url, '分享链接已复制')}>
              复制
            </button>
          </div>
        ) : (
          <div className="sg-note">
            App 包需要在 <code>VITE_PUBLIC_BASE_URL</code> 配置对外 H5 域名后才能复制分享链接。
          </div>
        )}
        {trip ? <div className="sg-trip">《{trip.title || '未命名行程'}》· 只读视图</div> : null}
        <button className="btn btn-primary sg-close" type="button" onClick={close}>
          知道了
        </button>
      </div>
    </div>
  )
}
