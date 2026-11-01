const config = require('../../config')

function decode(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (e) {
    return value
  }
}

function safeHash(path) {
  let hash = path || '/'
  if (hash.charAt(0) !== '/') hash = '/' + hash
  return hash
}

Page({
  data: {
    src: '',
    error: false,
    errorMessage: '',
    loading: true,
    h5Base: config.h5Base,
  },

  shareContext: null,
  srcCache: '',

  onLoad(options) {
    const tripId = decode(options.tripId || options.trip_id || '') || config.defaultTripId
    const readonly = options.readonly === '1' || options.readonly === 'true'
    const title = decode(options.title || '') || config.brand
    const explicitPath = decode(options.path || '')
    const hash = explicitPath
      ? safeHash(explicitPath)
      : tripId
        ? `${readonly ? '/s' : '/t'}/${tripId}`
        : '/'
    const src = `${config.h5Base}/?tp_platform=miniprogram#${hash}`

    this.srcCache = src
    this.shareContext = tripId
      ? { tripId, title, path: `/s/${tripId}` }
      : { tripId: '', title: config.brand, path: '/' }

    this.setData({ src })
    wx.setNavigationBarTitle({ title: title === config.brand ? config.brand : title })
    if (options.error) {
      this.onWebError()
    }
  },

  onLoadWeb() {
    this.setData({ loading: false, error: false })
  },

  onWebError(event) {
    const detail = (event && event.detail) || {}
    this.setData({
      error: true,
      loading: false,
      errorMessage: detail.errMsg || '页面加载失败，请检查网络与业务域名配置。',
    })
  },

  onMessage(event) {
    const messages = (event && event.detail && event.detail.data) || []
    const last = Array.isArray(messages) ? messages[messages.length - 1] : messages
    if (!last || last.type !== 'trip') return
    this.shareContext = {
      tripId: last.tripId || '',
      title: last.title || config.brand,
      path: last.path || (last.tripId ? `/s/${last.tripId}` : '/'),
    }
    if (last.tripId) {
      try {
        wx.setStorageSync('tp:lastTrip', this.shareContext)
      } catch (e) {
        // ignore storage quota
      }
    }
  },

  onRetry() {
    const src = this.srcCache
    this.setData({ src: '', error: false, loading: true, errorMessage: '' })
    setTimeout(() => this.setData({ src }), 60)
  },

  onCopyUrl() {
    wx.setClipboardData({
      data: this.srcCache,
      success: () => wx.showToast({ title: 'H5 地址已复制', icon: 'none' }),
    })
  },

  onShareAppMessage() {
    const ctx = this.shareContext || { tripId: '', title: config.brand, path: '/' }
    const path = ctx.tripId
      ? `/pages/index/index?tripId=${encodeURIComponent(ctx.tripId)}&readonly=1&title=${encodeURIComponent(ctx.title || '')}`
      : '/pages/index/index'
    return {
      title: ctx.tripId ? `${ctx.title || '我的行程'} · Trace Planner` : '用 Trace Planner 一句话规划旅行',
      path,
    }
  },

  onShareTimeline() {
    const ctx = this.shareContext || {}
    return {
      title: ctx.tripId ? `${ctx.title || '我的行程'} · Trace Planner` : '用 Trace Planner 一句话规划旅行',
      query: ctx.tripId ? `tripId=${encodeURIComponent(ctx.tripId)}&readonly=1` : '',
    }
  },
})
