import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  BatteryCharging,
  CheckCircle2,
  Cpu,
  Gauge,
  Loader2,
  Monitor,
  RefreshCw,
  Sparkles,
  Zap
} from 'lucide-react'
import type { OptimizeStep, PerformanceStatus, VisualEffectsMode } from '@shared/types'
import { Button, Card, Chip, ProgressBar, Skeleton } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { cx, errorMessage, formatDuration, timeAgo } from '../../lib/format'

const VISUAL_OPTIONS: Array<{
  id: VisualEffectsMode
  title: string
  description: string
  icon: React.ReactNode
}> = [
  {
    id: 'performance',
    title: '最佳性能',
    description: '关闭窗口动画与透明特效，界面响应更快，适合低配置电脑',
    icon: <Zap size={17} />
  },
  {
    id: 'balanced',
    title: '由 Windows 管理',
    description: '系统根据硬件自动平衡外观与性能，推荐大多数用户使用',
    icon: <Monitor size={17} />
  },
  {
    id: 'appearance',
    title: '最佳外观',
    description: '保留全部动画与视觉效果，界面更精致但占用更多资源',
    icon: <Sparkles size={17} />
  }
]

function isHighPerformance(name: string): boolean {
  return /高性能|high performance/i.test(name)
}

export function SpeedPerformance(): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [status, setStatus] = useState<PerformanceStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [planGuid, setPlanGuid] = useState<string | null>(null)
  const [visualEffects, setVisualEffects] = useState<VisualEffectsMode | null>(null)
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<OptimizeStep[]>([])

  const load = async (force: boolean): Promise<void> => {
    if (force) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const data = await api.speed.performance(force)
      setStatus(data)
      setPlanGuid(null)
      setVisualEffects(null)
    } catch (loadError) {
      const message = errorMessage(loadError)
      setError(message)
      toast.push('error', message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load(false)
  }, [])

  const apply = async (): Promise<void> => {
    if (busy || (!planGuid && !visualEffects)) return
    setBusy(true)
    try {
      const outcome = await api.speed.optimizePerformance({
        planGuid: planGuid ?? undefined,
        visualEffects: visualEffects ?? undefined
      })
      setStatus(outcome.status)
      setSteps(outcome.steps)
      setPlanGuid(null)
      setVisualEffects(null)
      toast.push(outcome.result.ok ? 'success' : 'error', outcome.result.message)
    } catch (actionError) {
      toast.push('error', errorMessage(actionError))
    } finally {
      setBusy(false)
    }
  }

  const requestHighPerformance = (): void => {
    if (!status) return
    const target = status.plans.find((plan) => !plan.active && isHighPerformance(plan.name))
    if (!target) {
      toast.push('info', '未找到可用的高性能电源计划，请在下方的计划列表中选择')
      return
    }
    setPlanGuid(target.guid)
    setVisualEffects('performance')
    toast.push('info', '已选择高性能预设，点击「应用性能优化」后生效')
  }

  return (
    <div className="speed-panel">
      <Card className="speed-hero speed-performance-hero">
        <div className="speed-hero-copy">
          <span className="speed-kicker">
            <Gauge size={15} />
            性能加速
          </span>
          <div className="speed-hero-number">
            {loading ? <Skeleton className="skeleton-speed-count" /> : <b>{status?.memoryPercent ?? 0}%</b>}
            <span>内存占用</span>
          </div>
          <div className="speed-hero-bar">
            <ProgressBar
              value={status?.memoryPercent ?? 0}
              tone={(status?.memoryPercent ?? 0) >= 85 ? 'red' : (status?.memoryPercent ?? 0) >= 70 ? 'amber' : 'brand'}
            />
          </div>
          <p>
            {loading
              ? '正在读取电源计划与系统负载…'
              : status
                ? `当前电源计划「${status.activePlan}」，视觉效果：${status.visualEffectsLabel}，共 ${status.processCount} 个进程，已运行 ${formatDuration(status.uptimeSec * 1000)}。`
                : '暂时无法读取性能设置。'}
          </p>
        </div>
        <div className="speed-hero-actions">
          <Button
            variant="primary"
            icon={<Sparkles size={16} />}
            onClick={requestHighPerformance}
            disabled={loading || busy || !status}
          >
            高性能预设
          </Button>
          <Button
            variant="secondary"
            icon={refreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? '读取中…' : '重新检测'}
          </Button>
        </div>
      </Card>

      {error ? (
        <div className="inline-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => void load(true)}>
            重试
          </button>
        </div>
      ) : null}

      <div className="speed-performance-grid">
        <Card className="speed-action-card">
          <div className="card-head">
            <div>
              <h3>电源计划</h3>
              <p>切换 Windows 的功耗与性能策略，插电时建议使用高性能</p>
            </div>
            {status ? <Chip tone="blue">当前：{status.activePlan}</Chip> : null}
          </div>
          {loading ? (
            <div className="speed-option-list">
              {[0, 1, 2].map((row) => (
                <div className="speed-option speed-option-skeleton" key={row}>
                  <Skeleton className="skeleton-line" />
                </div>
              ))}
            </div>
          ) : status && status.plans.length > 0 ? (
            <div className="plan-grid">
              {status.plans.map((plan) => {
                const selected = planGuid === plan.guid
                return (
                  <button
                    type="button"
                    key={plan.guid}
                    className={cx('plan-card', plan.active && 'is-active', selected && 'is-selected')}
                    onClick={() => setPlanGuid(selected ? null : plan.guid)}
                  >
                    <span className="plan-icon">
                      {isHighPerformance(plan.name) ? <Zap size={17} /> : <BatteryCharging size={17} />}
                    </span>
                    <span className="plan-copy">
                      <b>{plan.name}</b>
                      <span>{plan.active ? '正在使用' : selected ? '待应用' : '点击选择'}</span>
                    </span>
                    {plan.active ? <Chip tone="green">当前</Chip> : null}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="speed-empty-note">未能读取电源计划列表，请尝试重新检测。</p>
          )}
        </Card>

        <Card className="speed-action-card">
          <div className="card-head">
            <div>
              <h3>视觉效果</h3>
              <p>调整窗口动画与透明效果，减少图形资源占用</p>
            </div>
            {status ? <Chip tone="violet">当前：{status.visualEffectsLabel}</Chip> : null}
          </div>
          <div className="speed-option-list">
            {VISUAL_OPTIONS.map((option) => {
              const selected = visualEffects === option.id
              return (
                <button
                  type="button"
                  key={option.id}
                  className={cx('speed-option', selected && 'is-checked', status?.visualEffectsMode === option.id && 'is-current')}
                  onClick={() => setVisualEffects(selected ? null : option.id)}
                >
                  <span className="speed-option-icon">{option.icon}</span>
                  <div>
                    <b>{option.title}</b>
                    <span>{option.description}</span>
                  </div>
                  {status?.visualEffectsMode === option.id ? <Chip tone="green">当前</Chip> : null}
                </button>
              )
            })}
          </div>
          <p className="speed-inline-note">
            视觉效果修改保存在当前用户配置中，重新登录后完全生效；应用前会自动备份原设置。
          </p>
        </Card>
      </div>

      <div className="speed-apply-bar">
        <div>
          <b>{planGuid || visualEffects ? '已选择待应用的优化项' : '选择上方任一项后再应用'}</b>
          <span>
            {planGuid ? '切换电源计划' : ''}
            {planGuid && visualEffects ? ' · ' : ''}
            {visualEffects
              ? `视觉效果：${VISUAL_OPTIONS.find((option) => option.id === visualEffects)?.title}`
              : ''}
          </span>
        </div>
        <Button
          variant="primary"
          icon={<Cpu size={16} />}
          onClick={() => void apply()}
          loading={busy}
          disabled={!planGuid && !visualEffects}
        >
          应用性能优化
        </Button>
      </div>

      {steps.length > 0 ? (
        <Card className="speed-result-card">
          <div className="card-head">
            <div>
              <h3>最近一次优化结果</h3>
              <p>修改内容与生效方式</p>
            </div>
          </div>
          <div className="speed-result-list">
            {steps.map((step) => (
              <div className="speed-result-row" key={step.id}>
                {step.ok ? (
                  <CheckCircle2 size={16} className="speed-result-ok" />
                ) : (
                  <AlertTriangle size={16} className="speed-result-warn" />
                )}
                <b>{step.label}</b>
                <span>{step.message}</span>
                <Chip tone={step.ok ? 'green' : 'amber'}>{step.ok ? '已应用' : '未生效'}</Chip>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {status ? <p className="speed-footnote">性能数据采集于 {timeAgo(status.capturedAt)}，仅用于展示当前状态。</p> : null}
    </div>
  )
}
