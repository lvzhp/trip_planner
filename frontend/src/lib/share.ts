import type { Trip } from '../types'
import { shareTrip } from '../platform/share'
import { useUiStore } from '../stores/uiStore'
import { toast } from './toast'

/**
 * 业务层的「分享这份行程」。
 * 只读链接永远走 /s/{id}，避免把可编辑工作台发给别人。
 */
export async function shareCurrentTrip(trip: Trip): Promise<void> {
  const result = await shareTrip({
    tripId: trip.tripId,
    title: trip.title || '我的行程',
    path: `/s/${trip.tripId}`,
    summary: [
      trip.constraints?.origin,
      trip.days?.length ? `${trip.days.length} 天` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  })
  if (result.method === 'guide') {
    useUiStore.getState().openShareGuide()
  } else if (result.method === 'unavailable') {
    toast(result.message || '当前环境暂不支持分享', 'info')
  }
}
