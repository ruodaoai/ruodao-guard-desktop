import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Cpu,
  Loader2,
  MemoryStick,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  XCircle
} from 'lucide-react'
import type { ProcessReport, SpeedProcess } from '@shared/types'
import { Button, Card, Chip, ConfirmDialog, EmptyState, ProgressBar, Skeleton } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { cx, errorMessage, formatBytes, timeAgo } from '../../lib/format'

type Filter = 'recommended' | 'background' | 'app' | 'all' | 'protected'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'recommended', label: '推荐优化' },
  { id: 'background', label: '后台程序' },
  { id: 'app', label: '运行中的应用' },
  { id: 'all', label: '全部' },
  { id: 'protected', label: '受保护' }
]

function matchesFilter(process: SpeedProcess, filter: Filter): boolean {
  if (filter === 'recommended') return process.recommended
  if (filter === 'background') return process.kind === 'background'
  if (filter === 'app') return process.kind === 'app'
  if (filter === 'protected') return !process.canEnd
  return true
}

function ProcessIcon({ process }: { process: SpeedProcess }): React.JSX.Element {
  if (process.kind === 'security' || process.kind === 'system') return <ShieldCheck size={17} />
  if (process.kind === 'app') return <Cpu size={17} />
  return <MemoryStick size={17} />
}

export function SpeedSoftware(): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [report, setReport] = useState<ProcessReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('recommended')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<'selected' | 'recommended' | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (force: boolean): Promise<void> => {
    if (force) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const data = await api.speed.processes(force)
      setReport(data)
      setSelected(new Set())
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

  const processes = report?.processes ?? []
  const recommended = useMemo(() => processes.filter((item) => item.recommended), [processes])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return processes.filter((item) => {
      if (!matchesFilter(item, filter)) return false
      if (!keyword) return true
      return (
        item.name.toLowerCase().includes(keyword) ||
        item.company.toLowerCase().includes(keyword) ||
        item.windowTitle.toLowerCase().includes(keyword)
      )
    })
  }, [processes, filter, query])

  const selectable = filtered.filter((item) => item.canEnd)
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id))

  const toggleOne = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(selectable.map((item) => item.id)))
  }

  const selectedProcesses = processes.filter((item) => selected.has(item.id))
  const selectedBytes = selectedProcesses.reduce((sum, item) => sum + item.memoryBytes, 0)

  const countFor = (id: Filter): number => processes.filter((item) => matchesFilter(item, id)).length

  const targetList = pending === 'recommended' ? recommended : selectedProcesses

  const applyEnd = async (): Promise<void> => {
    if (busy) return
    const targets = targetList.filter((item) => item.canEnd)
    if (targets.length === 0) {
      toast.push('info', '没有可结束的进程')
      setPending(null)
      return
    }
    setBusy(true)
    try {
      const outcome = await api.speed.endProcesses(targets.flatMap((item) => item.pids))
      setReport(outcome.report)
      setSelected(new Set())
      toast.push(outcome.result.ok ? 'success' : 'error', outcome.result.message)
    } catch (endError) {
      toast.push('error', errorMessage(endError))
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  return (
    <div className="speed-panel">
      <Card className="speed-hero">
        <div className="speed-hero-copy">
          <span className="speed-kicker">
            <Cpu size={15} />
            软件加速
          </span>
          <div className="speed-hero-number">
            {loading ? <Skeleton className="skeleton-speed-count" /> : <b>{report?.memoryPercent ?? 0}%</b>}
            <span>内存占用</span>
          </div>
          <div className="speed-hero-bar">
            <ProgressBar
              value={report?.memoryPercent ?? 0}
              tone={(report?.memoryPercent ?? 0) >= 85 ? 'red' : (report?.memoryPercent ?? 0) >= 70 ? 'amber' : 'brand'}
            />
          </div>
          <p>
            {loading
              ? '正在采集进程占用，请稍候…'
              : report
                ? `已用 ${formatBytes(report.memoryUsed)} / ${formatBytes(report.memoryTotal)}，当前 ${report.processCount} 个进程。推荐结束 ${report.recommendedCount} 个后台程序，可释放约 ${formatBytes(report.recommendedBytes)} 内存。`
                : '暂时无法读取进程信息。'}
          </p>
        </div>
        <div className="speed-hero-actions">
          <Button
            variant="primary"
            icon={<Sparkles size={16} />}
            disabled={loading || refreshing || recommended.length === 0}
            onClick={() => setPending('recommended')}
          >
            优化推荐项
          </Button>
          <Button
            variant="secondary"
            icon={refreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? '采集中…' : '重新采集'}
          </Button>
        </div>
      </Card>

      <Card className="speed-list-card">
        <div className="speed-list-head">
          <div className="filter-tabs" role="group" aria-label="筛选进程">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cx('filter-tab', filter === item.id && 'filter-tab-active')}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <span className="filter-tab-count">{loading ? '—' : countFor(item.id)}</span>
              </button>
            ))}
          </div>
          <label className="speed-search">
            <Search size={15} />
            <input
              value={query}
              placeholder="搜索进程名称或公司"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {error ? (
          <div className="inline-error">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button type="button" onClick={() => void load(true)}>
              重试
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="speed-rows">
            {[0, 1, 2, 3, 4].map((row) => (
              <div className="speed-row-skeleton" key={row}>
                <Skeleton className="skeleton-icon" />
                <Skeleton className="skeleton-line" />
                <Skeleton className="skeleton-line short" />
              </div>
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <>
            <div className="speed-row speed-row-head">
              <label className="speed-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={selectable.length === 0}
                  aria-label="全选可结束进程"
                  onChange={toggleAll}
                />
                全选
              </label>
              <span />
              <span>进程</span>
              <span>内存 / CPU</span>
              <span className="speed-head-op">操作</span>
            </div>
            <div className="speed-rows">
              {filtered.map((item) => {
                const checked = selected.has(item.id)
                const recommendedTag = item.recommended
                return (
                  <div
                    className={cx(
                      'speed-row',
                      !item.canEnd && 'speed-row-protected',
                      checked && 'speed-row-checked'
                    )}
                    key={item.id}
                  >
                    <label className="speed-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!item.canEnd}
                        aria-label={`选择 ${item.name}`}
                        onChange={() => toggleOne(item.id)}
                      />
                    </label>
                    <span className={cx('speed-app-icon', `speed-app-${item.kind}`)}>
                      <ProcessIcon process={item} />
                    </span>
                    <div className="speed-app-copy">
                      <div className="speed-app-title">
                        <b>{item.name}</b>
                        {item.processCount > 1 ? <Chip tone="gray">{item.processCount} 个实例</Chip> : null}
                        {recommendedTag ? <Chip tone="green">推荐优化</Chip> : null}
                        {item.kind === 'app' ? <Chip tone="blue">应用</Chip> : null}
                        {!item.canEnd ? <Chip tone="amber">受保护</Chip> : null}
                      </div>
                      <span className="speed-app-meta">
                        {item.windowTitle || item.company || item.path || '系统进程'}
                      </span>
                      <span className="speed-app-note">{item.note}</span>
                    </div>
                    <div className="speed-app-metrics">
                      <b>{formatBytes(item.memoryBytes)}</b>
                      <span>{item.cpuPercent > 0 ? `${item.cpuPercent}% CPU` : 'CPU 空闲'}</span>
                    </div>
                    <div className="speed-app-op">
                      {item.canEnd ? (
                        <button
                          type="button"
                          className="pill-action pill-action-danger"
                          onClick={() => {
                            setSelected(new Set([item.id]))
                            setPending('selected')
                          }}
                        >
                          结束
                        </button>
                      ) : (
                        <span className="speed-locked">
                          <ShieldCheck size={13} />
                          不可结束
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <EmptyState
            icon={<Cpu size={26} />}
            title={query ? '没有匹配的进程' : filter === 'recommended' ? '没有需要优化的进程' : '没有符合条件的进程'}
            description={
              query
                ? '换个关键词，或切换筛选条件查看其他进程'
                : filter === 'recommended'
                  ? '后台程序占用较低，当前无需结束任何进程'
                  : '切换筛选条件查看其他进程'
            }
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery('')
                  setFilter('all')
                }}
              >
                查看全部进程
              </Button>
            }
          />
        )}

        {selected.size > 0 ? (
          <div className="speed-selection-bar">
            <span>
              已选择 <b>{selected.size}</b> 个进程 · 可释放约 {formatBytes(selectedBytes)}
            </span>
            <div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                取消选择
              </Button>
              <Button variant="danger" size="sm" onClick={() => setPending('selected')}>
                结束所选
              </Button>
            </div>
          </div>
        ) : (
          <div className="speed-notice">
            <ShieldCheck size={15} />
            <span>
              系统进程、安全软件与本程序自身受保护，无法被结束。结束后台程序只释放内存，需要时会随系统或手动重新启动。
              {report ? ` 采集于 ${timeAgo(report.sampledAt)}。` : ''}
            </span>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => {
          if (!busy) setPending(null)
        }}
        onConfirm={() => void applyEnd()}
        title={pending === 'recommended' ? `结束 ${recommended.length} 个推荐优化进程？` : `结束 ${selectedProcesses.length} 个进程？`}
        confirmText="确认结束"
        tone="danger"
        busy={busy}
        icon={<XCircle size={22} />}
      >
        <p>结束进程会立即释放内存，但正在运行的应用可能丢失未保存的数据。</p>
        <div className="confirm-list">
          {targetList.slice(0, 5).map((item) => (
            <div className="confirm-list-item" key={item.id}>
              <span>{item.name}</span>
              <b>{formatBytes(item.memoryBytes)}</b>
            </div>
          ))}
          {targetList.length > 5 ? (
            <div className="confirm-list-item">
              <span>其余 {targetList.length - 5} 个进程</span>
              <b>—</b>
            </div>
          ) : null}
        </div>
        <p className="modal-note">结束操作会记录到「系统修复 · 危险操作日志」，可随时查看。</p>
      </ConfirmDialog>
    </div>
  )
}
