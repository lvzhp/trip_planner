import { useEffect, useMemo, useRef } from 'react'
import { useTripStore } from '../stores/tripStore'
import { Icon } from '../lib/icons'
import {
  buildSubagents,
  SUBAGENT_ROLE_LABELS,
  SUBAGENT_STATUS_LABELS,
  SUBAGENT_STEP_KIND_LABELS,
} from '../lib/subagents'

/**
 * 子 Agent 独立视图：点开某个子 Agent 后，对话区整体切换到这里。
 *
 * - 只读：子 Agent 不能对话，所以没有 Composer；
 * - 运行中按 SSE `subagent` 事件实时追加步骤；
 * - 顶部「返回对话」回到原来的聊天内容。
 */
export function SubagentView({ runKey, onBack }: { runKey: string; onBack: () => void }) {
  const events = useTripStore(s => s.events)
  const runs = useMemo(() => buildSubagents(events), [events])
  const run = runs[runKey]
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    body.scrollTop = body.scrollHeight
  }, [run?.steps.length, run?.status])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const role = run ? SUBAGENT_ROLE_LABELS[run.role] || run.role : '子 Agent'
  const steps = run?.steps || []
  const findings = run?.findings || []
  const gaps = run?.gaps || []
  const running = run?.status === 'running' || run?.status === 'queued'

  return (
    <div className="subagent-view">
      <div className="sv-head">
        <button className="sv-back" type="button" onClick={onBack} aria-label="返回对话">
          <Icon name="chevronRight" className="sv-back-icon" /> 返回对话
        </button>
        <span className="sv-title">子 Agent · {role}</span>
        {run ? (
          <span className={`sv-status sv-status-${run.status}`}>
            {SUBAGENT_STATUS_LABELS[run.status] || run.status}
          </span>
        ) : null}
        <span className="sv-readonly">
          <Icon name="lock" /> 只读
        </span>
      </div>

      {!run ? (
        <div className="sv-empty">
          <p>这个子 Agent 还没有运行记录。</p>
          <button className="btn btn-sm" type="button" onClick={onBack}>
            返回对话
          </button>
        </div>
      ) : (
        <>
          <div className="sv-meta">
            <span>{run.taskId}</span>
            <span>模型 {run.model || '—'}</span>
            <span>用时 {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : running ? '进行中' : '—'}</span>
            <span>步数 {run.stepsUsed ?? steps.length}</span>
            <span>工具 {run.toolCallsUsed ?? '—'} 次</span>
            <span>独立来源 {run.independentSources ?? 0}</span>
          </div>

          <div className="sv-body" ref={bodyRef}>
            {run.goal ? <div className="sv-goal">调研目标：{run.goal}</div> : null}

            <div className="sv-section-title">运行轨迹</div>
            {steps.length === 0 ? (
              <div className="sv-live">
                {running ? <span className="spinner spinner-sm" /> : null}
                {running ? '等待子 Agent 启动…' : '没有产生工具调用。'}
              </div>
            ) : (
              <ol className="rm-steps sv-steps">
                {steps.map(step => (
                  <li className={`rm-step${step.ok === false ? ' fail' : ''}`} key={step.index}>
                    <span className="rm-step-no">{step.index}</span>
                    <span className="rm-step-kind">{SUBAGENT_STEP_KIND_LABELS[step.kind] || step.kind}</span>
                    <span className="rm-step-tool">{step.tool || ''}</span>
                    {step.ok != null ? (
                      <span className={`rm-step-ok${step.ok ? ' ok' : ''}`}>{step.ok ? '成功' : '失败'}</span>
                    ) : null}
                    {step.durationMs != null ? <span className="rm-step-ms">{step.durationMs}ms</span> : null}
                    {step.summary ? <div className="rm-step-summary">{step.summary}</div> : null}
                    {step.args && Object.keys(step.args).length > 0 ? (
                      <code className="rm-step-args">{JSON.stringify(step.args)}</code>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}

            {running ? (
              <div className="sv-live">
                <span className="spinner spinner-sm" /> 子 Agent 正在运行，新步骤会实时出现在上方…
              </div>
            ) : null}

            {run.error ? <div className="sv-error">失败原因：{run.error}</div> : null}
            {run.summary ? (
              <>
                <div className="sv-section-title">摘要</div>
                <div className="sv-summary">{run.summary}</div>
              </>
            ) : null}

            {findings.length > 0 ? (
              <>
                <div className="sv-section-title">结论（{findings.length}）</div>
                <ul className="rm-findings">
                  {findings.map((finding: any, index: number) => (
                    <li key={index}>
                      <span className={`rd-kind rd-kind-${finding.kind || 'clue'}`}>
                        {finding.kind === 'fact' ? '事实' : finding.kind === 'experience' ? '经验' : '线索'}
                      </span>
                      <span>{finding.claim}</span>
                      {finding.evidence?.[0]?.url ? (
                        <a href={finding.evidence[0].url} target="_blank" rel="noreferrer noopener">
                          出处
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {gaps.length > 0 ? (
              <>
                <div className="sv-section-title">没查到的</div>
                <ul className="rm-gaps">
                  {gaps.map((gap: string, index: number) => (
                    <li key={index}>{gap}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>

          <div className="sv-foot">
            <span>子 Agent 只读 · 不支持对话</span>
            <button className="btn btn-sm" type="button" onClick={onBack}>
              返回对话
            </button>
          </div>
        </>
      )}
    </div>
  )
}
