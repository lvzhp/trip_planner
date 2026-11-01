import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { UserProfile } from '../types'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'
import { useTripStore } from '../stores/tripStore'

/**
 * 首屏偏好问卷（docs/07 §7）。
 *
 * 长期口味 = 记忆一次永久生效；同行人忌口 = 每趟 ask_user 问。
 * 纯 chips 多选一次性提交，零打字。**只在档案不存在时弹一次**，
 * 跳过也写 dismissed=true 永久不再弹（否则每次刷新被拦，用户会疯）。
 * 想重填走设置弹窗的「我的偏好」。
 *
 * 分享页（readonly）不弹：访问者不是行程主人，不该被要求填口味档案。
 */

interface Props {
  /** 保存成功后通知调用方（用于刷新详情缓存的 profileHash 相关状态） */
  onSaved?: (profile: UserProfile) => void
}

export function ProfileOnboarding({ onSaved }: Props) {
  const readonly = useTripStore(s => s.readonly)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [diet, setDiet] = useState<string[]>([])
  const [taste, setTaste] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (readonly) {
      setChecked(true)
      return
    }
    let cancelled = false
    void api
      .profile()
      .then(p => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => {
        /* 拿不到档案就不弹，不阻塞主流程 */
      })
      .finally(() => {
        if (!cancelled) setChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [readonly])

  if (readonly || !checked || !profile || profile.exists) return null

  const options = profile.options || { diet: [], taste: [] }

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter(x => x !== value) : [...list, value])
  }

  const submit = async (skip: boolean) => {
    setSaving(true)
    try {
      const saved = skip
        ? await api.updateProfile({ skip: true })
        : await api.updateProfile({ diet, taste })
      setProfile(saved)
      onSaved?.(saved)
      if (!skip) toast('已记住你的口味，之后不再问')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'xCircle')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="settings-scrim" onClick={() => void submit(true)} />
      <div className="settings-modal profile-modal" role="dialog" aria-modal="true" aria-label="口味偏好">
        <div className="settings-head">
          <div>
            <div className="settings-title">
              <Icon name="utensils" /> 先说说你的口味
            </div>
            <div className="settings-sub">
              只问一次，以后每个地点的美食推荐都按这个来。同行人有没有忌口，规划行程时会另外问。
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="跳过" onClick={() => void submit(true)} disabled={saving}>
            <Icon name="x" />
          </button>
        </div>

        <div className="settings-body">
          {options.diet.length > 0 && (
            <section className="settings-section">
              <h3>忌口（硬约束，推荐时直接排除）</h3>
              <div className="profile-chips">
                {options.diet.map(o => (
                  <button
                    key={o}
                    type="button"
                    className={`sd-chip${diet.includes(o) ? ' active' : ''}`}
                    disabled={saving}
                    onClick={() => toggle(diet, setDiet, o)}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </section>
          )}

          {options.taste.length > 0 && (
            <section className="settings-section">
              <h3>爱吃什么</h3>
              <div className="profile-chips">
                {options.taste.map(o => (
                  <button
                    key={o}
                    type="button"
                    className={`sd-chip${taste.includes(o) ? ' active' : ''}`}
                    disabled={saving}
                    onClick={() => toggle(taste, setTaste, o)}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="settings-note">
            <Icon name="info" /> 随时可在右上角「接入配置 → 我的偏好」里修改。改了之后已生成的地点攻略会自动重新检索。
          </div>
        </div>

        <div className="settings-foot">
          <button className="btn" type="button" onClick={() => void submit(true)} disabled={saving}>
            跳过
          </button>
          <button className="btn btn-primary" type="button" onClick={() => void submit(false)} disabled={saving}>
            {saving ? <span className="spinner spinner-sm" /> : null}
            {diet.length || taste.length ? '记住并开始规划' : '都没有，开始规划'}
          </button>
        </div>
      </div>
    </>
  )
}
