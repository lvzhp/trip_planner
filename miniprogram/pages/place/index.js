const config = require('../../config')

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function decode(value, fallback) {
  if (!value) return fallback
  try {
    return decodeURIComponent(value)
  } catch (e) {
    return value
  }
}

Page({
  data: {
    name: '',
    lng: null,
    lat: null,
    poiId: '',
    mode: 'car',
    opened: false,
    failed: false,
    errorMessage: '',
    h5Base: config.h5Base,
  },

  onLoad(options) {
    const name = decode(options.name, '目的地')
    const lng = num(options.lng)
    const lat = num(options.lat)
    this.setData({
      name,
      lng,
      lat,
      poiId: options.poiId || '',
      mode: options.mode || 'car',
    })
    wx.setNavigationBarTitle({ title: name })
    if (lng != null && lat != null) {
      // 延迟一点，等页面渲染完成再唤起腾讯地图
      setTimeout(() => this.openLocation(), 260)
    } else {
      this.setData({ failed: true, errorMessage: '这个地点还没有坐标，可以复制名称到地图 App 搜索。' })
    }
  },

  openLocation() {
    const { name, lng, lat } = this.data
    if (lng == null || lat == null) {
      this.setData({ failed: true, errorMessage: '没有可用的经纬度。' })
      return
    }
    wx.openLocation({
      latitude: Number(lat),
      longitude: Number(lng),
      name,
      address: '',
      scale: 16,
      fail: err => {
        this.setData({
          failed: true,
          errorMessage: (err && err.errMsg) || '无法唤起地图，请复制名称后手动搜索。',
        })
      },
      complete: () => this.setData({ opened: true }),
    })
  },

  copyName() {
    wx.setClipboardData({
      data: this.data.name,
      success: () => wx.showToast({ title: '地点名称已复制', icon: 'none' }),
    })
  },

  copyCoords() {
    const { lng, lat } = this.data
    if (lng == null || lat == null) return
    wx.setClipboardData({
      data: `${lng},${lat}`,
      success: () => wx.showToast({ title: '坐标已复制', icon: 'none' }),
    })
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) })
  },
})
