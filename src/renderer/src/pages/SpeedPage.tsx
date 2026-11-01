import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  Cpu,
  Gauge,
  Globe2,
  Loader2,
  Rocket,
  Sparkles,
  Zap
} from 'lucide-react'
import type { ProcessReport, StartupReport } from '@shared/types'
import { Button, Card, Chip, ConfirmDialog, EmptyState, Skeleton } from '../components/ui'
import { useToast } from '../components/Toast'
import { cx, errorMessage, formatBytes } from '../lib/format'
import { StartupPage } from './StartupPage'
import { SpeedNetwork } from './speed/SpeedNetwork'
import { SpeedPerformance } from './speed/SpeedPerformance'
import { SpeedSoftware } from './speed/SpeedSoftware'

type SpeedTab = 'overview' | 'software' | 'network' | 'performance' | 'startup'

const TABS: Array<{ id: SpeedTab; label: string }> = [
  { id: 'overview', label: '开机加速' },
  { id: 'software', label: '软件加速' },
  { id: 'network', label: '网络加速' },
  { id: 'performance', label: '性能加速' },
  { id: 'startup', label: '启动项管理' }
]

const IMPACT_TONE = {
  high: 'red',
  medium: 'amber',
  low: 'green'
} as const

export function SpeedPage(): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [tab, setTab] = useState<SpeedTab>('overview')
  const [startup, setStartup] = useState<StartupReport | null>(null)
  const [processes, setProcesses] = useState<ProcessReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const [startupResult, processResult] = await Promise.allSettled([api.startup.list(), api.speed.processes()])
    if (startupResult.status === 'fulfilled') setStartup(startupResult.value)
    if (processResult.status === 'fulfilled') setProcesses(processResult.value)
    const failure = [startupResult, processResult].find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') {
      const message = errorMessage(failure.reason)
      setError(message)
      toast.push('error', message)
    }
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [])

  const recommended = processes?.processes.filter((item) => item.recommended) ?? []
  const highImpact = startup?.items.filter((item) => item.enabled && item.impact === 'high') ?? []

  const runOneClick = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const parts: string[] = []
    let ok = false
    try {
      if (highImpact.length > 0) {
        const outcome = await api.startup.optimize()
        setStartup(outcome.report)
        if (outcome.result.ok) {
          ok = true
          parts.push(outcome.result.message)
        } else {
          parts.push(outcome.result.message)
        }
      }
      if (recommended.length > 0) {
        const outcome = await api.speed.endProcesses(recommended.flatMap((item) => item.pids))
        setProcesses(outcome.report)
        if (outcome.result.ok) ok = true
        parts.push(outcome.result.message)
      }
      toast.push(ok ? 'success' : 'error', parts.length > 0 ? parts.join('；') : '当前没有需要加速的项目')
    } catch (actionError) {
      toast.push('error', errorMessage(actionError))
    } finally {
      setBusy(false)
      setPending(false)
    }
  }

  const go = (next: SpeedTab): void => setTab(next)

  return (
    <div className="page speed-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">加速中心</h1>
          <p className="page-subtitle">从开机启动、后台进程、网络与系统性能四个方向释放电脑速度，所有改动均可回溯</p>
        </div>
        <div className="page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={loading ? <Loader2 size={15} className="spin" /> : <Zap size={15} />}
            onClick={() => void load()}
            disabled={loading || busy}
          >
            {loading ? '正在读取…' : '刷新状态'}
          </Button>
        </div>
      </div>

      <div className="speed-tabs" role="tablist" aria-label="加速模块">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={cx('speed-tab', tab === item.id && 'speed-tab-active')}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'overview' && highImpact.length > 0 ? <span className="speed-tab-dot" /> : null}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <>
          {error ? (
            <div className="inline-error">
              <AlertTriangle size={16} />
              <span>{error}</span>
              <button type="button" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : null}

          <Card className="speed-hero speed-startup-hero">
            <div className="speed-hero-visual">
              <span className="speed-hero-ring">
                <Rocket size={26} />
              </span>
            </div>
            <div className="speed-hero-copy">
              <span className="speed-kicker">
                <Rocket size={15} />
                开机加速
              </span>
              <div className="speed-hero-number">
                {loading ? <Skeleton className="skeleton-speed-count" /> : <b>{startup?.enabledCount ?? 0}</b>}
                <span>项随系统启动</span>
              </div>
              <p>
                {loading
                  ? '正在读取启动项与后台进程…'
                  : startup && startup.enabledCount > 0
                    ? `其中 ${startup.highImpactCount} 项为高影响启动项；当前有 ${recommended.length} 个后台程序推荐优化，可释放约 ${formatBytes(processes?.recommendedBytes ?? 0)} 内存。`
                    : '开机启动项处于理想状态，可以继续从后台进程、网络与系统性能释放更多速度。'}
              </p>
              <div className="speed-hero-actions speed-hero-actions-inline">
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Zap size={18} />}
                  onClick={() => setPending(true)}
                  disabled={loading || busy || (highImpact.length === 0 && recommended.length === 0)}
                >
                  一键加速
                </Button>
                <Button variant="secondary" size="lg" icon={<Cpu size={17} />} onClick={() => go('software')}>
                  查看后台进程
                </Button>
              </div>
            </div>
            <div className="speed-startup-metrics">
              <div className="speed-metric">
                <span>高影响启动项</span>
                <b className={cx(highImpact.length > 0 && 'is-danger')}>{loading ? '—' : startup?.highImpactCount ?? 0}</b>
              </div>
              <div className="speed-metric">
                <span>推荐结束进程</span>
                <b>{loading ? '—' : recommended.length}</b>
              </div>
              <div className="speed-metric">
                <span>可释放内存</span>
                <b>{loading ? '—' : formatBytes(processes?.recommendedBytes ?? 0)}</b>
              </div>
            </div>
          </Card>

          <div className="speed-tile-grid">
            <button type="button" className="speed-tile speed-tile-software" onClick={() => go('software')}>
              <span className="speed-tile-icon">
                <Cpu size={20} />
              </span>
              <span className="speed-tile-copy">
                <b>软件加速</b>
                <span>
                  {loading
                    ? '正在采集进程…'
                    : processes
                      ? `${processes.recommendedCount} 个后台程序可优化 · 内存占用 ${processes.memoryPercent}%`
                      : '结束后台进程，释放内存'}
                </span>
              </span>
              <ChevronRight size={16} className="speed-tile-arrow" />
            </button>
            <button type="button" className="speed-tile speed-tile-network" onClick={() => go('network')}>
              <span className="speed-tile-icon">
                <Globe2 size={20} />
              </span>
              <span className="speed-tile-copy">
                <b>网络加速</b>
                <span>刷新 DNS、清理异常代理、优化 TCP 参数</span>
              </span>
              <ChevronRight size={16} className="speed-tile-arrow" />
            </button>
            <button type="button" className="speed-tile speed-tile-performance" onClick={() => go('performance')}>
              <span className="speed-tile-icon">
                <Gauge size={20} />
              </span>
              <span className="speed-tile-copy">
                <b>性能加速</b>
                <span>切换电源计划与视觉效果，降低图形资源占用</span>
              </span>
              <ChevronRight size={16} className="speed-tile-arrow" />
            </button>
            <button type="button" className="speed-tile speed-tile-startup" onClick={() => go('startup')}>
              <span className="speed-tile-icon">
                <Rocket size={20} />
              </span>
              <span className="speed-tile-copy">
                <b>启动项管理</b>
                <span>{loading ? '正在读取…' : `共 ${startup?.items.length ?? 0} 项，可逐项启用或禁用`}</span>
              </span>
              <ChevronRight size={16} className="speed-tile-arrow" />
            </button>
          </div>

          <div className="speed-overview-grid">
            <Card className="speed-startup-card">
              <div className="card-head">
                <div>
                  <h3>高影响启动项</h3>
                  <p>随系统启动且资源占用较高的程序，可在启动项管理中逐项调整</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => go('startup')}>
                  管理全部
                  <ChevronRight size={14} />
                </Button>
              </div>
              {loading ? (
                <div className="speed-rows">
                  {[0, 1, 2].map((row) => (
                    <div className="speed-row-skeleton" key={row}>
                      <Skeleton className="skeleton-icon" />
                      <Skeleton className="skeleton-line" />
                      <Skeleton className="skeleton-line short" />
                    </div>
                  ))}
                </div>
              ) : highImpact.length > 0 ? (
                <div className="speed-rows">
                  {highImpact.slice(0, 5).map((item) => (
                    <div className="speed-simple-row" key={item.id}>
                      <span className="speed-simple-icon">
                        <Rocket size={16} />
                      </span>
                      <div className="speed-simple-copy">
                        <b>{item.name}</b>
                        <span>{item.tip}</span>
                      </div>
                      <Chip tone={IMPACT_TONE[item.impact]}>{item.impact === 'high' ? '高影响' : '中影响'}</Chip>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Rocket size={26} />}
                  title={startup ? '没有高影响启动项' : '未能读取启动项'}
                  description={startup ? '当前开机启动项整体影响较低，无需调整。' : '请点击右上角「刷新状态」重试。'}
                  action={
                    <Button variant="secondary" size="sm" onClick={() => go('startup')}>
                      查看启动项
                    </Button>
                  }
                />
              )}
            </Card>

            <Card className="speed-safe-card">
              <div className="speed-safe-head">
                <span className="speed-safe-icon">
                  <Sparkles size={18} />
                </span>
                <div>
                  <h3>加速也会留痕</h3>
                  <p>所有高影响操作都会记录，可在系统修复中追溯</p>
                </div>
              </div>
              <ul className="speed-safe-list">
                <li>结束后台进程会写入「危险操作日志」，包含进程名称与时间。</li>
                <li>禁用启动项只影响当前用户，可随时在启动项管理中恢复。</li>
                <li>网络与性能优化会先备份原设置，再执行修改。</li>
              </ul>
              <div className="speed-safe-tags">
                <Chip tone="green">可回溯</Chip>
                <Chip tone="blue">无广告</Chip>
                <Chip tone="violet">本地执行</Chip>
              </div>
            </Card>
          </div>

          <ConfirmDialog
            open={pending}
            onClose={() => {
              if (!busy) setPending(false)
            }}
            onConfirm={() => void runOneClick()}
            title="执行一键加速？"
            confirmText="立即加速"
            tone="amber"
            busy={busy}
            icon={<Zap size={22} />}
          >
            <p>将根据当前检测结果执行以下操作，建议先保存正在编辑的文件：</p>
            <div className="confirm-list">
              <div className="confirm-list-item">
                <span>禁用高影响启动项</span>
                <b>{highImpact.length} 项</b>
              </div>
              <div className="confirm-list-item">
                <span>结束后台推荐进程</span>
                <b>
                  {recommended.length} 个 · {formatBytes(processes?.recommendedBytes ?? 0)}
                </b>
              </div>
            </div>
            {recommended.length > 0 ? (
              <p className="modal-note">
                将结束：{recommended.slice(0, 5).map((item) => item.name).join('、')}
                {recommended.length > 5 ? ` 等 ${recommended.length} 个进程` : ''}。系统与安全进程不会被结束。
              </p>
            ) : null}
            <p className="modal-note">操作会写入「系统修复 · 危险操作日志」。</p>
          </ConfirmDialog>
        </>
      ) : null}

      {tab === 'software' ? <SpeedSoftware /> : null}
      {tab === 'network' ? <SpeedNetwork /> : null}
      {tab === 'performance' ? <SpeedPerformance /> : null}
      {tab === 'startup' ? <StartupPage embedded /> : null}
    </div>
  )
}
