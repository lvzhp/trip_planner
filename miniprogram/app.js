const config = require('./config')

App({
  globalData: {
    h5Base: config.h5Base,
    lastTrip: null,
  },

  onLaunch() {
    this.globalData.h5Base = config.h5Base
  },
})
