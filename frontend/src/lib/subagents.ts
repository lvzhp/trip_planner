import type { SseEvent } from '../types'

/** 子 Agent 的一次动作（与后端 ResearchStep 对齐，SSE 已转 camelCase）。 */
export interface SubagentStep {
  index: number
  kind: 'tool' | 'submit' | 'closing' | 'error'
  tool?: string | null
  args?: Record<string, unknown>
  ok?: boolean | null
  summary?: string | null
  durationMs?: number | null
}

export type SubagentStatus = 'queued' | 'running' | 'ok' | 'partial' | 'failed'

/** 一个子 Agent 的完整运行状态：从 tool_call 排队 → subagent 事件 → 最终 tool_result。 */
export interface SubagentRun {
  key: string
  taskId: string
  turnId: string
  role: string
  goal?: string
  model?: string | null
  status: SubagentStatus
  steps: SubagentStep[]
  summary?: string | null
  gaps: string[]
  findings: any[]
  findingsCount: number
  independentSources?: number
  durationMs?: number | null
  stepsUsed?: number | null
  toolCallsUsed?: number | null
  error?: string | null
  live: boolean
}

export function subagentKey(turnId: string | null | undefined, taskId: string): string {
  return `${turnId || 'turn'}:${taskId}`
}

function emptyRun(turnId: string, taskId: string, init: Partial<SubagentRun> = {}): SubagentRun {
  return {
    key: subagentKey(turnId, taskId),
    taskId,
    turnId,
    role: 'unknown',
    status: 'queued',
    steps: [],
    gaps: [],
    findings: [],
    findingsCount: 0,
    live: true,
    ...init,
  }
}

/**
 * 从事件流重建子 Agent 状态：历史回放和实时 SSE 用同一份逻辑。
 *
 * 三种事件参与：
 * - `tool_call(dispatch_research)`：先建立 queued 条目（用户能立刻看到要跑哪几个）；
 * - `subagent`：started / step / finished，边跑边更新；
 * - `tool_result(dispatch_research)`：用最终 trace + findings 覆盖，保证刷新后完整。
 */
export function buildSubagents(events: SseEvent[]): Record<string, SubagentRun> {
  const runs: Record<string, SubagentRun> = {}

  const ensure = (turnId: string, taskId: string, init: Partial<SubagentRun> = {}): SubagentRun => {
    const key = subagentKey(turnId, taskId)
    let run = runs[key]
    if (!run) {
      run = emptyRun(turnId, taskId, init)
      runs[key] = run
    } else {
      run = Object.assign(run, init)
    }
    return run
  }

  for (const event of events) {
    const payload: any = event.payload || {}
    const turnId = event.turnId || ''

    if (event.type === 'tool_call' && payload.tool === 'dispatch_research') {
      const tasks: any[] = Array.isArray(payload.args?.tasks) ? payload.args.tasks : []
      for (const task of tasks) {
        const taskId = task?.taskId || task?.task_id
        if (!taskId) continue
        ensure(turnId, String(taskId), {
          role: task.role || 'unknown',
          goal: task.goal || '',
          status: 'queued',
          live: true,
        })
      }
      continue
    }

    if (event.type === 'subagent') {
      const taskId = payload.taskId || payload.task_id
      if (!taskId) continue
      const run = ensure(turnId, String(taskId), {
        role: payload.role || 'unknown',
        goal: payload.goal || '',
        model: payload.model || null,
      })
      if (payload.state === 'started') {
        run.status = 'running'
        run.live = true
        if (payload.model) run.model = payload.model
        if (payload.goal) run.goal = payload.goal
      } else if (payload.state === 'step') {
        const step = payload.step
        if (step) {
          const index = Number(step.index) || run.steps.length + 1
          if (!run.steps.some(item => item.index === index)) {
            run.steps.push({
              index,
              kind: step.kind || 'tool',
              tool: step.tool ?? null,
              args: step.args || {},
              ok: step.ok ?? null,
              summary: step.summary ?? null,
              durationMs: step.durationMs ?? step.duration_ms ?? null,
            })
          }
        }
        run.status = 'running'
        run.live = true
      } else if (payload.state === 'finished') {
        run.status = (payload.status as SubagentStatus) || 'failed'
        run.live = false
        run.summary = payload.summary ?? run.summary
        run.gaps = payload.gaps || run.gaps
        run.findingsCount = payload.findingsCount ?? run.findingsCount
        run.durationMs = payload.durationMs ?? run.durationMs
        run.stepsUsed = payload.stepsUsed ?? run.stepsUsed
        run.toolCallsUsed = payload.toolCallsUsed ?? run.toolCallsUsed
        run.error = payload.error ?? null
      }
      continue
    }

    if (event.type === 'tool_result' && payload.tool === 'dispatch_research') {
      const results: any[] = Array.isArray(payload.data?.results) ? payload.data.results : []
      for (const result of results) {
        const taskId = result.taskId || result.task_id
        if (!taskId) continue
        const run = ensure(turnId, String(taskId), { role: result.role || 'unknown' })
        run.role = result.role || run.role
        run.status = (result.status as SubagentStatus) || run.status
        run.summary = result.summary ?? run.summary
        run.gaps = Array.isArray(result.gaps) ? result.gaps : run.gaps
        run.findings = Array.isArray(result.findings) ? result.findings : run.findings
        run.findingsCount = run.findings.length
        run.independentSources = result.independentSources ?? run.independentSources
        run.error = result.error ?? run.error
        const trace = result.trace
        if (trace) {
          run.model = trace.model ?? run.model
          run.durationMs = trace.durationMs ?? run.durationMs
          run.stepsUsed = trace.stepsUsed ?? run.stepsUsed
          run.toolCallsUsed = trace.toolCallsUsed ?? run.toolCallsUsed
          run.steps = Array.isArray(trace.steps) ? trace.steps : run.steps
          run.goal = trace.goal || run.goal
        }
        run.live = false
      }
    }
  }

  return runs
}

export const SUBAGENT_ROLE_LABELS: Record<string, string> = {
  route: '路线',
  experience: '经验',
  transport: '交通',
  conditions: '天候',
}

export const SUBAGENT_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  ok: '完成',
  partial: '部分完成',
  failed: '失败',
}

export const SUBAGENT_STEP_KIND_LABELS: Record<string, string> = {
  tool: '工具调用',
  submit: '提交结论',
  closing: '兜底收尾',
  error: '错误',
}
