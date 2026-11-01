import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 原生壳。
 *
 * 首次生成原生工程：
 *   pnpm cap:add:ios       # 需要 Xcode
 *   pnpm cap:add:android   # 需要 Android Studio / SDK
 *
 * 真机连本地 dev server（H5 热更新 + 模拟 App 环境）：
 *   CAP_SERVER_URL=http://<你的局域网IP>:5180 pnpm cap:sync
 *   CAP_SERVER_URL=http://<你的局域网IP>:5180 pnpm cap:ios
 *
 * 正式包：
 *   cp .env.app.example .env.app    # 填 VITE_API_BASE / VITE_PUBLIC_BASE_URL
 *   pnpm cap:sync
 */
const devServerUrl = process.env.CAP_SERVER_URL

const config: CapacitorConfig = {
  appId: 'com.traceplanner.app',
  appName: 'Trace Planner',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    ...(devServerUrl
      ? {
          url: devServerUrl,
          cleartext: devServerUrl.startsWith('http://'),
        }
      : {}),
  },
  ios: {
    contentInset: 'always',
    backgroundColor: '#F8FAFB',
  },
  android: {
    backgroundColor: '#F8FAFB',
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#1D6F5C',
      showSpinner: false,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#FFFFFF',
    },
    Keyboard: {
      resize: 'native',
    },
  },
}

export default config
