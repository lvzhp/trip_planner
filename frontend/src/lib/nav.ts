/**
 * 高德导航深链（docs/07 §4）。
 *
 * 用 uri.amap.com 统一 URI：移动端自动唤起已装 App（callnative=1），未装开网页版，
 * 桌面端开网页版 —— 一套 URL 通吃，无需 UA 判断。
 *
 * 优先传 poiid 而非经纬度：打开高德自己的 POI 页（评分/营业状态/停车/实时路况
 * 全是高德权威数据），且完全不传坐标，规避 GCJ-02/WGS-84 坐标系问题。
 * 没有 poiid 才兜底传经纬度，并用 coordinate=gaode 显式声明坐标系。
 */

import { openPlaceLink } from '../platform/shell'
import { toast } from './toast'

const AMAP_URI = 'https://uri.amap.com'

/** 出行方式由行程主交通形态决定，不提供切换 UI（一趟行程交通形态固定）。 */
export function amapMode(transportMode?: string | null): 'car' | 'bus' | 'walk' {
  if (transportMode === 'self_drive' || transportMode === 'flight' || transportMode === 'train') {
    return 'car'
  }
  return 'bus'
}

export interface NavTarget {
  name: string
  amapPoiId?: string | null
  lng?: number | null
  lat?: number | null
}

/** 生成高德 POI/导航链接。有 poiid 走 POI 页，否则走经纬度导航。 */
export function amapUrl(target: NavTarget, transportMode?: string | null): string {
  if (target.amapPoiId) {
    const q = new URLSearchParams({
      poiid: target.amapPoiId,
      callnative: '1',
    })
    return `${AMAP_URI}/poi?${q.toString()}`
  }
  if (target.lng != null && target.lat != null) {
    const q = new URLSearchParams({
      to: `${target.lng},${target.lat},${target.name}`,
      mode: amapMode(transportMode),
      coordinate: 'gaode',
      callnative: '1',
    })
    return `${AMAP_URI}/navigation?${q.toString()}`
  }
  // 连坐标都没有：退化为高德网页搜索
  const q = new URLSearchParams({ keywords: target.name })
  return `${AMAP_URI}/search?${q.toString()}`
}

/**
 * 打开高德导航。
 *
 * 宿主差异交给 platform/shell 处理：
 * - App：Capacitor Browser 打开 URI（已装高德会唤起 App）
 * - 微信小程序：跳原生 pages/place（wx.openLocation）
 * - 其他：window.open / 同标签打开
 */
export function openAmap(target: NavTarget, transportMode?: string | null): void {
  void openPlaceLink({
    name: target.name,
    amapPoiId: target.amapPoiId,
    lng: target.lng,
    lat: target.lat,
    mode: amapMode(transportMode),
    transportMode,
    webUrl: amapUrl(target, transportMode),
  }).then(result => {
    if (result === 'failed') toast('当前环境无法唤起地图，请复制地址后手动搜索', 'info')
  })
}
