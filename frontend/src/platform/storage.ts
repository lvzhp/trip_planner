/**
 * 存储适配：小程序 web-view / 无痕模式 / 被系统清理后，localStorage 都可能抛异常。
 * 统一走一层内存兜底，业务代码不需要 try/catch。
 */

const memory = new Map<string, string>()

export function storageGet(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key)
    if (value != null) return value
  } catch {
    /* private mode / storage disabled */
  }
  return memory.get(key) ?? null
}

export function storageSet(key: string, value: string): void {
  memory.set(key, value)
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* ignore quota / disabled */
  }
}

export function storageRemove(key: string): void {
  memory.delete(key)
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function storageJson<T>(key: string, fallback: T): T {
  const raw = storageGet(key)
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function storageSetJson(key: string, value: unknown): void {
  try {
    storageSet(key, JSON.stringify(value))
  } catch {
    /* ignore circular */
  }
}
