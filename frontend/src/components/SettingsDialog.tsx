import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { IntegrationCheck, RuntimeSettings, UserProfile } from '../types'
import { useAppStore } from '../stores/appStore'
import { useGuideStore } from '../stores/guideStore'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'

const KEY_FIELDS: { field: string; label: string; provider: string; hint: string }[] = [
  { field: 'deepseek_api_key', label: 'DeepSeek API Key', provider: 'deepseek', hint: 'sk-...' },
  { field: 'qwen_api_key', label: 'Qwen / DashScope API Key', provider: 'qwen', hint: 'sk-...' },
  { field: 'openai_api_key', label: 'OpenAI API Key', provider: 'openai', hint: 'sk-...' },
  { field: 'anthropic_api_key', label: 'Anthropic API Key', provider: 'anthropic', hint: 'sk-ant-...' },
  { field: 'custom_api_key', label: '自定义端点 API Key', provider: 'custom', hint: '本地模型可留空时也可填任意值' },
  { field: 'amap_web_key', label: '高德 Web 服务 Key', provider: 'amap', hint: '用于 POI / 路径 / 天气' },
  { field: 'amap_js_key', label: '高德 JS API Key', provider: 'amap', hint: '用于真实地图底图' },
  { field: 'amap_js_security_code', label: '高德 JS 安全密钥', provider: 'amap', hint: 'securityJsCode（可选）' },
  { field: 'tavily_api_key', label: 'Tavily API Key', provider: 'tavily', hint: 'tvly-...' },
]

const PROVIDER_LABELS: Record<string, string> = {
  mock: 'Mock（演示）',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  custom: '自定义 OpenAI-compatible',
  amap: '高德',
  tavily: 'Tavily',
  jev: 'Jev 决策路由',
}

const BASE_FIELDS: Record<string, string> = {
  deepseek: 'deepseek_base_url',
  qwen: 'qwen_base_url',
  openai: 'openai_base_url',
  anthropic: 'anthropic_base_url',
  custom: 'custom_base_url',
}

function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
}

function normalizeSettings(raw: RuntimeSettings): RuntimeSettings {
  const mapObject = (value: Record<string, any>) =>
    Object.fromEntries(Object.entries(value || {}).map(([k, v]) => [snakeKey(k), v]))
  return { ...raw, values: mapObject(raw.values), secrets: mapObject(raw.secrets) as any }
}

export function SettingsDialog() {
  const open = useUiStore(s => s.settingsOpen)
  const close = useUiStore(s => s.closeSettings)
  const config = useAppStore(s => s.config)
  const refreshConfig = useAppStore(s => s.refreshConfig)
  const [settings, setSettings] = useState<RuntimeSettings | null>(null)
  const [values, setValues] = useState<Record<string, any>>({})
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({})
  const [clearSecrets, setClearSecrets] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<IntegrationCheck | null>(null)
  const [reloadNeeded, setReloadNeeded] = useState(false)
  // 我的偏好（docs/07 §7）：独立于接入设置，改动即存
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setCheck(null)
    setReloadNeeded(false)
    setSecretInputs({})
    setClearSecrets([])
    api
      .settings()
      .then(raw => {
        const data = normalizeSettings(raw)
        setSettings(data)
        setValues({ ...data.values })
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
    api
      .profile()
      .then(setProfile)
      .catch(() => setProfile(null))
  }, [open])

  const toggleProfile = async (field: 'diet' | 'taste', value: string) => {
    if (!profile || profileSaving) return
    const list = profile[field]
    const next = list.includes(value) ? list.filter(x => x !== value) : [...list, value]
    setProfileSaving(true)
    try {
      const saved = await api.updateProfile({ [field]: next })
      setProfile(saved)
      // 偏好变化 → 攻略缓存的 profileHash 变化 → 清本地缓存让下次打开重新生成
      useGuideStore.getState().reset()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存偏好失败', 'xCircle')
    } finally {
      setProfileSaving(false)
    }
  }

  const providers = settings?.providerCatalog || config?.providers || []
  const currentProvider = values.default_provider || 'mock'
  const currentGroup = providers.find(p => p.id === currentProvider)
  const configuredKeys = useMemo(() => {
    const out: Record<string, boolean> = {}
    for (const item of KEY_FIELDS) out[item.field] = !!settings?.secrets?.[item.field]?.configured
    return out
  }, [settings])

  if (!open) return null

  const setValue = (key: string, value: any) => setValues(v => ({ ...v, [key]: value }))
  const setSecret = (field: string, value: string) => {
    setSecretInputs(v => ({ ...v, [field]: value }))
    if (value) setClearSecrets(c => c.filter(x => x !== field))
  }
  const markClear = (field: string) => {
    setSecretInputs(v => ({ ...v, [field]: '' }))
    setClearSecrets(c => (c.includes(field) ? c.filter(x => x !== field) : [...c, field]))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await api.updateSettings({
        values,
        secrets: Object.fromEntries(Object.entries(secretInputs).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])),
        clearSecrets,
      })
      const normalized = normalizeSettings(res.settings)
      setSettings(normalized)
      setValues({ ...normalized.values })
      setSecretInputs({})
      setClearSecrets([])
      await refreshConfig()
      const group = normalized.providerCatalog.find(p => p.id === normalized.values.default_provider)
      if (group?.available) {
        const model = group.models.find(m => m.id === normalized.values.default_model) || group.models[0]
        if (model) {
          useUiStore.getState().setModel(
            { provider: group.id, model: model.id, name: model.name, providerName: group.provider },
            true,
          )
        }
      }
      toast('集成配置已保存')
      setReloadNeeded(res.reloadRequired)
      const tested = await api.checkIntegrations({
        provider: normalized.values.default_provider,
        model: normalized.values.default_model,
      })
      setCheck(tested)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const testOnly = async () => {
    setSaving(true)
    setError(null)
    try {
      const tested = await api.checkIntegrations({
        provider: values.default_provider,
        model: values.default_model,
      })
      setCheck(tested)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const isDemo = currentProvider === 'mock'
  const providerUnavailable = currentProvider !== 'mock' && !currentGroup?.available
  const isReal = !isDemo && !providerUnavailable

  return (
    <>
      <div className="settings-scrim" onClick={close} />
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="接入与设置">
        <div className="settings-head">
          <div>
            <div className="settings-title">
              <Icon name="settings" /> 接入与设置
            </div>
            <div className="settings-sub">
              真实项目配置 · 密钥只保存在本机 <code>backend/data/runtime_settings.json</code>（600），API 只返回脱敏状态
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭" onClick={close}>
            <Icon name="x" />
          </button>
        </div>

        {loading && (
          <div className="settings-loading">
            <span className="spinner" /> 读取配置…
          </div>
        )}
        {error && (
          <div className="settings-error">
            <Icon name="xCircle" /> {error}
          </div>
        )}

        {!loading && settings && (
          <div className="settings-body">
            <div className={`settings-mode ${isReal ? 'real' : 'demo'}`}>
              <span className="mode-dot" />
              <div>
                <strong>
                  {isDemo ? '当前是演示模式' : providerUnavailable ? '真实 Provider 尚未配置完整' : '当前是真实模式'}
                </strong>
                <p>
                  {isDemo
                    ? 'Mock Agent 只用于验收脚本；要真实规划，请选择真实 provider 并填写 API Key。'
                    : providerUnavailable
                      ? '已选择真实 provider，但缺少对应 API Key；保存 Key 后才能发起真实请求，当前不会用 Mock 冒充。'
                      : '请求会走真实 LLM 与外部工具。所有写操作仍由服务端校验器强制。'}
                </p>
              </div>
            </div>

            <section className="settings-section">
              <h3>模型</h3>
              <div className="settings-grid two">
                <label>
                  <span>默认 Provider</span>
                  <select value={currentProvider} onChange={e => {
                    const provider = e.target.value
                    setValue('default_provider', provider)
                    const group = providers.find(p => p.id === provider)
                    const model = group?.models[0]
                    if (model) setValue('default_model', model.id)
                  }}>
                    {providers.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.provider}{p.available ? '' : '（未配置）'}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>默认模型</span>
                  <input
                    list="settings-models"
                    value={values.default_model || ''}
                    onChange={e => setValue('default_model', e.target.value)}
                    placeholder="deepseek-flash"
                  />
                  <datalist id="settings-models">
                    {(currentGroup?.models || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </datalist>
                </label>
              </div>
              <div className="settings-note">
                {currentGroup?.available
                  ? `当前 provider 可用（${currentGroup.provider}）。`
                  : '当前 provider 还不可用：填写对应 API Key 后才能真实调用。'}
              </div>

              {['deepseek', 'qwen', 'openai', 'anthropic', 'custom'].map(pid => {
                const key = KEY_FIELDS.find(k => k.provider === pid)!
                const base = BASE_FIELDS[pid]
                const configured = configuredKeys[key.field]
                return (
                  <details className="settings-provider" key={pid} open={currentProvider === pid}>
                    <summary>
                      <span>{PROVIDER_LABELS[pid]}</span>
                      <span className={`provider-state ${configured ? 'ok' : ''}`}>{configured ? '已配置' : '未配置'}</span>
                    </summary>
                    <div className="settings-grid two">
                      <label>
                        <span>{key.label}</span>
                        <SecretInput
                          field={key.field}
                          label={key.label}
                          hint={key.hint}
                          configured={configured}
                          secretHint={settings.secrets[key.field]?.hint || null}
                          value={secretInputs[key.field] || ''}
                          clearing={clearSecrets.includes(key.field)}
                          onChange={v => setSecret(key.field, v)}
                          onClear={() => markClear(key.field)}
                        />
                      </label>
                      <label>
                        <span>Base URL</span>
                        <input
                          value={values[base] || ''}
                          onChange={e => setValue(base, e.target.value)}
                          placeholder="https://..."
                        />
                      </label>
                    </div>
                    {pid === 'custom' && (
                      <label>
                        <span>自定义模型名</span>
                        <input value={values.custom_model || ''} onChange={e => setValue('custom_model', e.target.value)} placeholder="qwen2.5:14b / local-model" />
                      </label>
                    )}
                  </details>
                )
              })}
            </section>

            <section className="settings-section">
              <h3>地图与外部工具</h3>
              <div className="settings-grid two">
                <label>
                  <span>地图 provider</span>
                  <select value={values.map_provider || 'auto'} onChange={e => setValue('map_provider', e.target.value)}>
                    <option value="auto">自动：有高德 JS key 用高德，否则用 OSM 真实地图</option>
                    <option value="amap">高德 JS API 2.0</option>
                    <option value="leaflet">Leaflet + OpenStreetMap</option>
                    <option value="svg">SVG 离线画布</option>
                  </select>
                </label>
                <label>
                  <span>高德 Web 服务 Base URL</span>
                  <input value={values.amap_base_url || ''} onChange={e => setValue('amap_base_url', e.target.value)} placeholder="https://restapi.amap.com/v3" />
                </label>
              </div>
              <div className="settings-grid two">
                <label>
                  <span>高德 Web 服务 Key</span>
                  <SecretInput
                    field="amap_web_key"
                    label="高德 Web 服务 Key"
                    hint="用于 POI / 路径 / 天气"
                    configured={configuredKeys.amap_web_key}
                    secretHint={settings.secrets.amap_web_key?.hint || null}
                    value={secretInputs.amap_web_key || ''}
                    clearing={clearSecrets.includes('amap_web_key')}
                    onChange={v => setSecret('amap_web_key', v)}
                    onClear={() => markClear('amap_web_key')}
                  />
                </label>
                <label>
                  <span>高德 JS API Key</span>
                  <SecretInput
                    field="amap_js_key"
                    label="高德 JS API Key"
                    hint="用于真实地图底图"
                    configured={configuredKeys.amap_js_key}
                    secretHint={settings.secrets.amap_js_key?.hint || null}
                    value={secretInputs.amap_js_key || ''}
                    clearing={clearSecrets.includes('amap_js_key')}
                    onChange={v => setSecret('amap_js_key', v)}
                    onClear={() => markClear('amap_js_key')}
                  />
                </label>
              </div>
              <div className="settings-grid two">
                <label>
                  <span>高德 JS 安全密钥 securityJsCode</span>
                  <SecretInput
                    field="amap_js_security_code"
                    label="高德 JS 安全密钥 securityJsCode"
                    hint="可选"
                    configured={configuredKeys.amap_js_security_code}
                    secretHint={settings.secrets.amap_js_security_code?.hint || null}
                    value={secretInputs.amap_js_security_code || ''}
                    clearing={clearSecrets.includes('amap_js_security_code')}
                    onChange={v => setSecret('amap_js_security_code', v)}
                    onClear={() => markClear('amap_js_security_code')}
                  />
                </label>
                <label>
                  <span>Tavily API Key</span>
                  <SecretInput
                    field="tavily_api_key"
                    label="Tavily API Key"
                    hint="tvly-..."
                    configured={configuredKeys.tavily_api_key}
                    secretHint={settings.secrets.tavily_api_key?.hint || null}
                    value={secretInputs.tavily_api_key || ''}
                    clearing={clearSecrets.includes('tavily_api_key')}
                    onChange={v => setSecret('tavily_api_key', v)}
                    onClear={() => markClear('tavily_api_key')}
                  />
                </label>
              </div>
              <label>
                <span>Tavily Base URL</span>
                <input value={values.tavily_base_url || ''} onChange={e => setValue('tavily_base_url', e.target.value)} placeholder="https://api.tavily.com" />
              </label>
            </section>

            <section className="settings-section">
              <h3>Jev 路由与子 Agent 调研</h3>
              <p className="settings-note">
                Jev 未配置时按降级规则收缩第三档工具（常开档与强制放行档不受影响）；
                子 Agent 调研需要真实模型，演示模式下会明确返回 not_configured。
              </p>
              <div className="settings-grid two">
                <label>
                  <span>Jev API Key</span>
                  <SecretInput
                    field="jev_api_key"
                    label="Jev API Key"
                    hint="可选；留空即降级"
                    configured={!!settings.secrets.jev_api_key?.configured}
                    secretHint={settings.secrets.jev_api_key?.hint || null}
                    value={secretInputs.jev_api_key || ''}
                    clearing={clearSecrets.includes('jev_api_key')}
                    onChange={v => setSecret('jev_api_key', v)}
                    onClear={() => markClear('jev_api_key')}
                  />
                </label>
                <label>
                  <span>Jev Base URL</span>
                  <input value={values.jev_base_url || ''} onChange={e => setValue('jev_base_url', e.target.value)} placeholder="https://www.dmxapi.cn" />
                </label>
                <label>
                  <span>Jev 接口路径</span>
                  <input value={values.jev_endpoint || ''} onChange={e => setValue('jev_endpoint', e.target.value)} placeholder="/typesafe/v1/systemone" />
                </label>
                <label>
                  <span>Jev 模型 ID（固定版本号）</span>
                  <input value={values.jev_model || ''} onChange={e => setValue('jev_model', e.target.value)} placeholder="jev-1.14.0" />
                </label>
                <label>
                  <span>子 Agent 用的便宜模型</span>
                  <input value={values.subagent_model || ''} onChange={e => setValue('subagent_model', e.target.value)} placeholder="留空 = 主模型" />
                </label>
              </div>
              <div className="settings-toggles">
                <label className="settings-toggle">
                  <input type="checkbox" checked={values.social_digest_enabled === true} onChange={e => setValue('social_digest_enabled', e.target.checked)} />
                  <span>
                    <strong>允许抓取公开文本平台的攻略线索</strong>
                    <small>默认关闭；线索永远只算 clue，不能写进票价/渠道/营业时间</small>
                  </span>
                </label>
                <label className="settings-toggle">
                  <input type="checkbox" checked={values.social_digest_login_enabled === true} onChange={e => setValue('social_digest_login_enabled', e.target.checked)} />
                  <span>
                    <strong>同时抓取登录墙平台（小红书/抖音/微博）</strong>
                    <small>默认关闭；需要自己登录的浏览器档案，且平台协议是否允许未知</small>
                  </span>
                </label>
              </div>
              <label>
                <span>公开平台列表（逗号分隔）</span>
                <input value={values.social_digest_platforms || ''} onChange={e => setValue('social_digest_platforms', e.target.value)} placeholder="zhihu,bilibili" />
              </label>
            </section>

            <section className="settings-section">
              <h3>运行模式与高级</h3>
              <div className="settings-toggles">
                <label className="settings-toggle">
                  <input type="checkbox" checked={values.demo_mode !== false} onChange={e => setValue('demo_mode', e.target.checked)} />
                  <span>
                    <strong>演示模式</strong>
                    <small>允许 Mock / 固定 2026-04-26 作为“今天”；真实部署请关闭</small>
                  </span>
                </label>
                <label className="settings-toggle">
                  <input type="checkbox" checked={values.seed_demo !== false} onChange={e => setValue('seed_demo', e.target.checked)} />
                  <span>
                    <strong>启动时 seed 示例行程</strong>
                    <small>只影响下一次启动；已有数据库不会被清空</small>
                  </span>
                </label>
                <label className="settings-toggle">
                  <input type="checkbox" checked={values.http_trust_env === true} onChange={e => setValue('http_trust_env', e.target.checked)} />
                  <span>
                    <strong>遵循 HTTP(S)_PROXY</strong>
                    <small>请求外部服务时使用环境代理；默认关闭以避免损坏的 NO_PROXY</small>
                  </span>
                </label>
              </div>
            </section>

            <section className="settings-section">
              <h3>我的偏好（口味记忆）</h3>
              <p className="settings-hint">
                长期口味只记一次，所有地点的美食推荐都按它来；同行人忌口每趟行程单独问。
                改动即保存，已生成的地点攻略会按新偏好重新检索。
              </p>
              {profile?.options?.diet?.length ? (
                <div className="profile-field">
                  <span className="profile-field-label">忌口</span>
                  <div className="profile-chips">
                    {profile.options.diet.map(o => (
                      <button
                        key={o}
                        type="button"
                        className={`sd-chip${profile.diet.includes(o) ? ' active' : ''}`}
                        disabled={profileSaving}
                        onClick={() => void toggleProfile('diet', o)}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {profile?.options?.taste?.length ? (
                <div className="profile-field">
                  <span className="profile-field-label">爱吃什么</span>
                  <div className="profile-chips">
                    {profile.options.taste.map(o => (
                      <button
                        key={o}
                        type="button"
                        className={`sd-chip${profile.taste.includes(o) ? ' active' : ''}`}
                        disabled={profileSaving}
                        onClick={() => void toggleProfile('taste', o)}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {!profile && <div className="settings-note"><Icon name="info" /> 偏好档案暂不可用。</div>}
            </section>

            {check && (
              <section className="settings-section">
                <h3>连接测试</h3>
                <div className="integration-list">
                  {check.results.map(r => (
                    <div className={`integration-row ${r.ok ? 'ok' : 'fail'}`} key={r.service}>
                      <span className="int-dot" />
                      <span className="int-label">{r.label}</span>
                      <span className="int-msg">{r.message}</span>
                      <span className="int-lat">{r.latencyMs}ms</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {reloadNeeded && (
              <div className="settings-reload">
                <Icon name="info" /> 地图/JS key 变更需要刷新页面生效
                <button className="btn btn-sm" type="button" onClick={() => location.reload()}>
                  刷新页面
                </button>
              </div>
            )}
          </div>
        )}

        <div className="settings-foot">
          <span className="settings-foot-note">
            <Icon name="lock" /> 密钥不会返回前端；仅显示尾号
          </span>
          <button className="btn btn-sm" type="button" onClick={close}>关闭</button>
          <button className="btn btn-sm" type="button" onClick={testOnly} disabled={saving || loading || !settings}>
            测试当前配置
          </button>
          <button className="btn btn-sm btn-primary" type="button" onClick={save} disabled={saving || loading || !settings}>
            {saving ? '保存中…' : '保存并测试'}
          </button>
        </div>
      </div>
    </>
  )
}

function SecretInput({
  label,
  hint,
  configured,
  secretHint,
  value,
  clearing,
  onChange,
  onClear,
}: {
  field: string
  label: string
  hint: string
  configured: boolean
  secretHint: string | null
  value: string
  clearing: boolean
  onChange: (v: string) => void
  onClear: () => void
}) {
  return (
    <div className={`secret-input${clearing ? ' clearing' : ''}`}>
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={clearing ? '保存后清除' : configured ? `已配置 ${secretHint || ''}，留空保持不变` : hint}
        aria-label={label}
      />
      {configured && (
        <button type="button" className="secret-clear" onClick={onClear} title={clearing ? '撤销清除' : '清除此密钥'}>
          {clearing ? '撤销' : '清除'}
        </button>
      )}
    </div>
  )
}
