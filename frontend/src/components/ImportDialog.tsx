import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { usePlaceStore } from '../stores/placeStore'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'
import type { CandidatePlace, ImportItem, ImportResult } from '../types'

type Mode = 'link' | 'text' | 'images'

/**
 * 链接 / 截图 / 粘贴文本导入（mindtrip/06 §9）+ 拍照识地（P2-2）。
 *
 * 管线：抓取/OCR → 抽地点 → 地理编码 → **候选确认面板** → 加入行程或收藏。
 * 没配置 OCR / 视觉模型时显式失败并给手动搜索入口，不假装识别成功。
 */
export function ImportDialog() {
  const open = useUiStore(s => s.importOpen)
  const close = useUiStore(s => s.closeImport)
  const tripId = useTripStore(s => s.tripId)
  const trip = useTripStore(s => s.trip)
  const readonly = useTripStore(s => s.readonly)
  const addPlace = useTripStore(s => s.addPlace)
  const savePlace = usePlaceStore(s => s.save)
  const activeDay = useUiStore(s => s.activeDay)
  const [mode, setMode] = useState<Mode>('link')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [rows, setRows] = useState<(ImportItem & { selected: boolean })[]>([])
  const [day, setDay] = useState(activeDay)
  const [fixIndex, setFixIndex] = useState<number | null>(null)
  const [fixQuery, setFixQuery] = useState('')
  const [fixBusy, setFixBusy] = useState(false)
  const [fixResults, setFixResults] = useState<CandidatePlace[]>([])
  const [fixMessage, setFixMessage] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setDay(activeDay)
  }, [open, activeDay])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  const dayOptions = useMemo(() => trip?.days || [], [trip?.days])
  const selectedCount = rows.filter(row => row.selected).length

  if (!open) return null

  const applyResult = (data: ImportResult) => {
    setResult(data)
    setRows(
      (data.items || []).map(item => ({
        ...item,
        selected: item.located && !item.duplicate,
      })),
    )
    if (data.message) toast(data.message, data.items?.length ? 'info' : 'xCircle')
    else if (data.items?.length) toast(`识别到 ${data.items.length} 个地点，请确认`, 'checkCircle')
  }

  const submitLink = async () => {
    if (!tripId) return
    if (!url.trim()) {
      toast('先粘贴一条链接', 'info')
      return
    }
    setBusy(true)
    try {
      applyResult(await api.importLink(tripId, { url: url.trim() }))
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'xCircle')
    } finally {
      setBusy(false)
    }
  }

  const submitText = async () => {
    if (!tripId) return
    if (!text.trim()) {
      toast('先粘一段带地名的正文', 'info')
      return
    }
    setBusy(true)
    try {
      applyResult(await api.importLink(tripId, { text: text.trim() }))
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'xCircle')
    } finally {
      setBusy(false)
    }
  }

  const submitImages = async (files: FileList | null, photo = false) => {
    if (!files?.length) return
    setBusy(true)
    try {
      const images = await Promise.all(
        Array.from(files)
          .slice(0, 10)
          .map(async file => ({
            filename: file.name,
            mime: file.type,
            dataBase64: await readFileAsDataUrl(file),
          })),
      )
      applyResult(await api.importImages(images, photo ? 'photo' : 'screenshot'))
    } catch (err) {
      toast(err instanceof Error ? err.message : '截图导入失败', 'xCircle')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const updateRow = (index: number, patch: Partial<ImportItem & { selected: boolean }>) => {
    setRows(list => list.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const runFixSearch = async () => {
    const query = fixQuery.trim()
    if (!query) return
    setFixBusy(true)
    setFixMessage(null)
    try {
      const data = await api.searchPlaces(query, trip?.days[0]?.stops[0]?.poi.city || null, 8, tripId)
      setFixResults(data.items || [])
      if (!data.items?.length) setFixMessage(data.message || '没找到，换个关键词')
    } catch (err) {
      setFixMessage(err instanceof Error ? err.message : '搜索失败')
    } finally {
      setFixBusy(false)
    }
  }

  const applyFix = (candidate: CandidatePlace) => {
    if (fixIndex == null) return
    updateRow(fixIndex, {
      name: candidate.name,
      poiId: candidate.poiId,
      amapPoiId: candidate.poiId.startsWith('q:') ? null : candidate.poiId,
      city: candidate.city ?? null,
      address: candidate.address ?? null,
      lat: candidate.lat ?? null,
      lng: candidate.lng ?? null,
      located: candidate.lat != null && candidate.lng != null,
      selected: true,
    })
    setFixIndex(null)
    setFixQuery('')
    setFixResults([])
    setFixMessage(null)
  }

  const addSelected = async () => {
    if (!tripId || readonly) return
    const chosen = rows.filter(row => row.selected && !row.duplicate)
    if (!chosen.length) {
      toast('先勾选要加入的地点', 'info')
      return
    }
    setBusy(true)
    let added = 0
    let missing = 0
    const addedStopIds: string[] = []
    for (const row of chosen) {
      const stopId = await addPlace(
        {
          poiId: row.poiId || row.amapPoiId || `imp:${row.name}`,
          name: row.name,
          category: row.category || 'place',
          lat: row.lat ?? null,
          lng: row.lng ?? null,
          city: row.city ?? null,
          address: row.address ?? null,
          source: 'import',
        },
        day,
        { silent: true },
      )
      if (stopId) {
        added += 1
        addedStopIds.push(stopId)
      } else {
        missing += 1
      }
    }
    setBusy(false)
    if (added) {
      toast(`已加入 ${added} 个地点到 Day ${day}`, 'checkCircle', {
        action: addedStopIds.length
          ? {
              label: '撤销',
              onClick: () => {
                for (const stopId of addedStopIds) void useTripStore.getState().removeStop(stopId, { silent: true })
              },
            }
          : undefined,
      })
      close()
    }
    if (missing) toast(`${missing} 个地点加入失败（可能没有坐标），可先手动搜索定位`, 'warn')
  }

  const saveSelected = async () => {
    const chosen = rows.filter(row => row.selected && row.located)
    if (!chosen.length) {
      toast('先勾选已定位的地点', 'info')
      return
    }
    for (const row of chosen) {
      await savePlace({
        poiId: row.poiId || row.amapPoiId || `imp:${row.name}`,
        name: row.name,
        category: row.category || 'place',
        lat: row.lat ?? null,
        lng: row.lng ?? null,
        city: row.city ?? null,
        address: row.address ?? null,
      })
    }
    close()
  }

  return (
    <div className="import-scrim" role="presentation" onClick={close}>
      <div className="import-dialog" role="dialog" aria-modal="true" aria-label="导入地点" onClick={event => event.stopPropagation()}>
        <header className="imp-head">
          <div>
            <h2>导入地点</h2>
            <p>支持小红书 / 公众号 / 网页链接、订单截图、粘贴文本。识别后先确认再加进行程。</p>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭导入" onClick={close}>
            <Icon name="x" />
          </button>
        </header>

        <div className="imp-tabs" role="tablist" aria-label="导入方式">
          {[
            ['link', '链接'],
            ['text', '文本'],
            ['images', '截图 / 拍照'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              className={mode === key ? 'active' : ''}
              onClick={() => setMode(key as Mode)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'link' && (
          <div className="imp-pane">
            <label className="imp-field">
              <span>链接</span>
              <input
                type="url"
                inputMode="url"
                placeholder="https://www.xiaohongshu.com/..."
                value={url}
                onChange={event => setUrl(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && void submitLink()}
              />
            </label>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => void submitLink()} disabled={busy}>
              {busy ? <span className="spinner spinner-xs" /> : <Icon name="search" />} 抓取并识别
            </button>
            <p className="imp-hint">抓不到内容时会明确报错，可以直接改用「文本」粘贴正文。</p>
          </div>
        )}

        {mode === 'text' && (
          <div className="imp-pane">
            <label className="imp-field">
              <span>正文 / 攻略摘录</span>
              <textarea
                rows={5}
                placeholder="粘贴包含地名的文本，例如：第二天住「禾木村」，顺路去五彩滩…"
                value={text}
                onChange={event => setText(event.target.value)}
              />
            </label>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => void submitText()} disabled={busy}>
              {busy ? <span className="spinner spinner-xs" /> : <Icon name="sparkle" />} 识别地点
            </button>
          </div>
        )}

        {mode === 'images' && (
          <div className="imp-pane">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="imp-file"
              aria-label="选择截图或拍照上传"
              onChange={event => void submitImages(event.target.files)}
            />
            <div className="imp-drop">
              <Icon name="camera" />
              <span>1–10 张截图，每张 ≤5MB</span>
              <em>上传前请先给订单号 / 手机号打码，原图不会被保存</em>
            </div>
            <button className="btn btn-sm" type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <span className="spinner spinner-xs" /> : <Icon name="download" />} 选择图片
            </button>
            <p className="imp-hint">
              未配置 OCR / 视觉模型时不会假装识别成功，会提示改用文本粘贴或手动搜索。
            </p>
          </div>
        )}

        {result && (
          <div className="imp-result">
            <div className="imp-result-head">
              <strong>确认候选（{rows.length}）</strong>
              {result.title && <span className="imp-result-title">{result.title}</span>}
            </div>
            {result.failures.length > 0 && (
              <ul className="imp-failures">
                {result.failures.slice(0, 4).map((failure, index) => (
                  <li key={index}>{failure}</li>
                ))}
              </ul>
            )}
            <div className="imp-rows">
              {rows.map((row, index) => (
                <div className={`imp-row${row.located ? '' : ' unlocated'}${row.duplicate ? ' duplicate' : ''}`} key={`${row.poiId || row.name}-${index}`}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row.name}`}
                    checked={row.selected}
                    onChange={event => updateRow(index, { selected: event.target.checked })}
                  />
                  <div className="imp-row-main">
                    <input
                      className="imp-name"
                      value={row.name}
                      aria-label={`第 ${index + 1} 个地点名称`}
                      onChange={event => updateRow(index, { name: event.target.value })}
                    />
                    <div className="imp-row-sub">
                      {row.city && <span>{row.city}</span>}
                      {row.address && <span>{row.address}</span>}
                      {!row.located && <span className="imp-tag warn">未定位</span>}
                      {row.duplicate && <span className="imp-tag">已在 Day {row.inTripDay ?? '—'}</span>}
                      {row.lat != null && row.lng != null && (
                        <span className="imp-coord">
                          {row.lat.toFixed(3)}, {row.lng.toFixed(3)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm imp-fix"
                    onClick={() => {
                      setFixIndex(index)
                      setFixQuery(row.name)
                      setFixResults([])
                      setFixMessage(null)
                    }}
                  >
                    手动搜索
                  </button>
                </div>
              ))}
            </div>

            {fixIndex != null && (
              <div className="imp-fix-panel">
                <div className="imp-fix-head">
                  <strong>给「{rows[fixIndex]?.name}」确认位置</strong>
                  <button className="icon-btn" type="button" aria-label="关闭手动搜索" onClick={() => setFixIndex(null)}>
                    <Icon name="x" />
                  </button>
                </div>
                <div className="imp-fix-row">
                  <input
                    type="search"
                    value={fixQuery}
                    placeholder="搜索地点名"
                    onChange={event => setFixQuery(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && void runFixSearch()}
                  />
                  <button className="btn btn-sm btn-primary" type="button" onClick={() => void runFixSearch()} disabled={fixBusy}>
                    {fixBusy ? <span className="spinner spinner-xs" /> : '搜索'}
                  </button>
                </div>
                {fixMessage && <div className="imp-fix-msg">{fixMessage}</div>}
                {fixResults.map(candidate => (
                  <button key={candidate.poiId} type="button" className="imp-fix-result" onClick={() => applyFix(candidate)}>
                    <span>{candidate.name}</span>
                    <em>{[candidate.city, candidate.address].filter(Boolean).join(' · ')}</em>
                  </button>
                ))}
              </div>
            )}

            <div className="imp-foot">
              <label className="imp-day">
                加入
                <select value={day} onChange={event => setDay(Number(event.target.value))} aria-label="选择加入哪一天">
                  {dayOptions.map(item => (
                    <option key={item.dayIndex} value={item.dayIndex}>
                      Day {item.dayIndex}
                    </option>
                  ))}
                </select>
              </label>
              <span className="imp-selected">已选 {selectedCount} 个</span>
              <button className="btn btn-sm" type="button" onClick={() => void saveSelected()}>
                <Icon name="checkCircle" /> 加入收藏
              </button>
              <button className="btn btn-sm btn-primary" type="button" onClick={() => void addSelected()} disabled={busy}>
                {busy ? <span className="spinner spinner-xs" /> : <Icon name="plus" />} 加入行程
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`${file.name} 读取失败`))
    reader.readAsDataURL(file)
  })
}
