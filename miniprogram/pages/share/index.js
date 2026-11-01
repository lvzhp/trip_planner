const config = require('../../config')

function decode(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (e) {
    return value
  }
}

Page({
  data: {
    tripId: '',
    title: '我的行程',
    path: '/',
    webUrl: '',
  },

  onLoad(options) {
    const tripId = decode(options.tripId || '')
    const title = decode(options.title || '') || '我的行程'
    const path = decode(options.path || '') || (tripId ? `/s/${tripId}` : '/')
    const webUrl = tripId ? `${config.h5Base}${path.startsWith('/s/') ? path : `/s/${tripId}`}` : config.h5Base
    this.setData({ tripId, title, path, webUrl })
    wx.setNavigationBarTitle({ title: '分享行程' })
  },

  onShareAppMessage() {
    const { tripId, title } = this.data
    return {
      title: tripId ? `${title} · Trace Planner` : '用 Trace Planner 一句话规划旅行',
      path: tripId
        ? `/pages/index/index?tripId=${encodeURIComponent(tripId)}&readonly=1&title=${encodeURIComponent(title)}`
        : '/pages/index/index',
    }
  },

  onShareTimeline() {
    const { tripId, title } = this.data
    return {
      title: tripId ? `${title} · Trace Planner` : '用 Trace Planner 一句话规划旅行',
      query: tripId ? `tripId=${encodeURIComponent(tripId)}&readonly=1` : '',
    }
  },

  copyLink() {
    wx.setClipboardData({
      data: this.data.webUrl,
      success: () => wx.showToast({ title: '只读链接已复制', icon: 'none' }),
    })
  },

  close() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: `/pages/index/index${this.data.tripId ? `?tripId=${this.data.tripId}&readonly=1` : ''}` }),
    })
  },
})
