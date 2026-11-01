import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Zap
} from 'lucide-react'
import type { StartupItem, StartupReport } from '@shared/types'
import { Button, Card, Chip, ConfirmDialog, EmptyState, Skeleton, Toggle } from '../components/ui'
import { useToast } from '../components/Toast'
import { cx, errorMessage, shortPath, timeAgo } from '../lib/format'

type Filter = 'all' | 'enabled' | 'disabled' | 'high'

const IMPACT_META: Record<StartupItem['impact'], { label: string; tone: 'red' | 'amber' | 'green' }> = {
  high: { label: '高影响', tone: 'red' },
  medium: { label: '中影响', tone: 'amber' },
  low: { label: '低影响', tone: 'green' }
}

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已禁用' },
  { id: 'high', label: '高影响' }
]

function ImpactIcon({ impact }: { impact: StartupItem['impact'] }): React.JSX.Element {
  if (impact === 'high') return <AlertTriangle size={17} />
  if (impact === 'medium') return <Zap size={17} />
  return <CheckCircle2 size={17} />
}

export function StartupPage({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [report, setReport] = useState<StartupReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [pendingDisable, setPendingDisable] = useState<StartupItem | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    api.startup
      .list()
      .then((data) => {
        if (!alive) return
        setReport(data)
        setLoadedAt(Date.now())
      })
      .catch((loadError) => {
        if (!alive) return
        const message = errorMessage(loadError)
        setError(message)
        toast.push('error', message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api, toast])

  const items = report?.items ?? []
  const lockedCount = items.filter((item) => !item.canToggle).length

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (filter === 'enabled') return item.enabled
      if (filter === 'disabled') return !item.enabled
      if (filter === 'high') return item.enabled && item.impact === 'high'
      return true
    })
  }, [items, filter])

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setError(null)
    try {
      const data = await api.startup.list(true)
      setReport(data)
      setLoadedAt(Date.now())
      toast.push('success', `启动项已刷新，当前 ${data.enabledCount} 项随系统启动`)
    } catch (refreshError) {
      const message = errorMessage(refreshError)
      setError(message)
      toast.push('error', message)
    } finally {
      setRefreshing(false)
    }
  }

  const applyToggle = async (item: StartupItem, enabled: boolean): Promise<void> => {
    if (busyId) return
    setBusyId(item.id)
    try {
      const outcome = await api.startup.setEnabled(item.id, enabled)
      setReport(outcome.report)
      setLoadedAt(Date.now())
      toast.push(outcome.result.ok ? 'success' : 'error', outcome.result.message)
    } catch (toggleError) {
      toast.push('error', errorMessage(toggleError))
    } finally {
      setBusyId(null)
      setPendingDisable(null)
    }
  }

  const requestToggle = (item: StartupItem, enabled: boolean): void => {
    if (!item.canToggle) {
      toast.push('info', '系统级启动项需要管理员权限，当前仅支持查看')
      return
    }
    if (enabled) {
      void applyToggle(item, true)
    } else {
      setPendingDisable(item)
    }
  }

  const filterCount = (id: Filter): number => {
    if (id === 'enabled') return report?.enabledCount ?? 0
    if (id === 'disabled') return report?.disabledCount ?? 0
    if (id === 'high') return report?.highImpactCount ?? 0
    return items.length
  }

  return (
    <div className={embedded ? 'startup-page startup-embedded' : 'page startup-page'}>
      {embedded ? null : (
        <div className="page-header">
          <div>
            <h1 className="page-title">开机加速</h1>
            <p className="page-subtitle">管理随 Windows 启动的程序，减少开机等待时间且不影响软件正常使用</p>
          </div>
          <div className="page-actions">
            <Button
              variant="secondary"
              size="sm"
              icon={refreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
              onClick={refresh}
              disabled={refreshing || loading}
            >
              {refreshing ? '刷新中…' : '刷新列表'}
            </Button>
          </div>
        </div>
      )}

      <Card className="startup-summary">
        <div className="startup-summary-main">
          <span className="startup-kicker">
            <Rocket size={15} />
            开机自启项
          </span>
          <div className="startup-big">
            {loading ? <Skeleton className="skeleton-startup-count" /> : <b>{report?.enabledCount ?? 0}</b>}
            <span>项随系统启动</span>
          </div>
          <p>
            {loading
              ? '正在读取注册表与启动文件夹…'
              : !report
                ? '暂时无法读取启动项信息，请稍后刷新。'
                : report.enabledCount === 0
                  ? '当前没有第三方程序随系统自动启动，开机速度保持在理想状态。'
                  : report.highImpactCount > 0
                    ? `其中 ${report.highImpactCount} 项为高影响启动项，建议确认来源后禁用不常用的程序。`
                    : '启动项整体影响较低，可根据使用习惯禁用不常用的程序。'}
          </p>
        </div>
        <div className="startup-metrics">
          <div className="startup-metric">
            <span>高影响</span>
            <b className={cx('startup-metric-high', (report?.highImpactCount ?? 0) > 0 && 'is-danger')}>
              {loading ? '—' : report?.highImpactCount ?? 0}
            </b>
          </div>
          <div className="startup-metric">
            <span>已禁用</span>
            <b>{loading ? '—' : report?.disabledCount ?? 0}</b>
          </div>
          <div className="startup-metric">
            <span>系统级只读</span>
            <b>{loading ? '—' : lockedCount}</b>
          </div>
        </div>
      </Card>

      <Card className="startup-list-card">
        <div className="card-head startup-card-head">
          <div>
            <h3>
              启动项
              <Chip tone="gray">{items.length}</Chip>
            </h3>
            <p>{loadedAt ? `列表读取于 ${timeAgo(loadedAt)}` : '读取注册表与启动文件夹中的启动项'}</p>
          </div>
          <div className="startup-head-actions">
            {embedded ? (
              <Button
                variant="ghost"
                size="sm"
                icon={refreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                onClick={refresh}
                disabled={refreshing || loading}
              >
                {refreshing ? '刷新中…' : '刷新'}
              </Button>
            ) : null}
            <div className="filter-tabs" role="group" aria-label="筛选启动项">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cx('filter-tab', filter === item.id && 'filter-tab-active')}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                  <span className="filter-tab-count">{filterCount(item.id)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {error ? (
          <div className="inline-error">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button type="button" onClick={refresh}>
              重试
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="startup-rows">
            {[0, 1, 2, 3, 4].map((row) => (
              <div className="startup-row-skeleton" key={row}>
                <Skeleton className="skeleton-icon" />
                <div className="skeleton-copy">
                  <Skeleton className="skeleton-line" />
                  <Skeleton className="skeleton-line short" />
                </div>
                <Skeleton className="skeleton-line short" />
                <Skeleton className="skeleton-toggle" />
              </div>
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="startup-rows">
            {filtered.map((item) => {
              const impact = IMPACT_META[item.impact]
              const busy = busyId === item.id
              return (
                <div
                  className={cx(
                    'startup-row',
                    `startup-impact-${item.impact}`,
                    !item.enabled && 'startup-row-off'
                  )}
                  key={item.id}
                >
                  <span className={cx('startup-row-icon', `startup-icon-${item.impact}`)}>
                    <ImpactIcon impact={item.impact} />
                  </span>
                  <div className="startup-copy">
                    <div className="startup-title-line">
                      <b>{item.name}</b>
                      <Chip tone={impact.tone}>{impact.label}</Chip>
                      {!item.enabled ? <Chip tone="gray">已禁用</Chip> : null}
                    </div>
                    <span className="startup-command" title={item.command}>
                      {shortPath(item.command, 42, 52)}
                    </span>
                    <span className="startup-tip">{item.tip}</span>
                  </div>
                  <div className="startup-meta">
                    <Chip tone="blue">{item.sourceLabel}</Chip>
                    <span className="startup-state">{item.enabled ? '随系统启动' : '不会自启'}</span>
                  </div>
                  <div className="startup-switch">
                    <Toggle
                      checked={item.enabled}
                      disabled={!item.canToggle || busy}
                      onChange={(next) => requestToggle(item, next)}
                      label={`${item.enabled ? '禁用' : '启用'} ${item.name}`}
                    />
                    <span className={cx('startup-switch-note', !item.canToggle && 'is-locked')}>
                      {busy ? (
                        <>
                          <Loader2 size={11} className="spin" />
                          处理中
                        </>
                      ) : !item.canToggle ? (
                        <>
                          <Lock size={11} />
                          系统级只读
                        </>
                      ) : item.enabled ? (
                        '已启用'
                      ) : (
                        '已禁用'
                      )}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={<Rocket size={26} />}
            title={items.length === 0 ? '没有读取到启动项' : '没有符合条件的启动项'}
            description={
              items.length === 0
                ? '注册表与启动文件夹中暂无可管理的启动项'
                : '切换筛选条件查看其他启动项'
            }
            action={
              filter !== 'all' ? (
                <Button variant="secondary" size="sm" onClick={() => setFilter('all')}>
                  查看全部
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={refresh} loading={refreshing}>
                  重新读取
                </Button>
              )
            }
          />
        )}

        <div className="startup-notice">
          <ShieldCheck size={15} />
          <span>
            禁用操作只修改当前用户的启动项，可随时在本页重新启用；系统级启动项以只读方式展示，避免误改共享配置。
            {report && report.disabledCount > 0 ? ` 已有 ${report.disabledCount} 项被本工具禁用，备份保存在本地数据目录。` : ''}
          </span>
        </div>
      </Card>

      <ConfirmDialog
        open={pendingDisable !== null}
        onClose={() => {
          if (!busyId) setPendingDisable(null)
        }}
        onConfirm={() => {
          if (pendingDisable) void applyToggle(pendingDisable, false)
        }}
        title={`禁用「${pendingDisable?.name ?? ''}」开机启动？`}
        confirmText="禁用启动项"
        tone="amber"
        busy={Boolean(pendingDisable && busyId === pendingDisable.id)}
        icon={<AlertTriangle size={22} />}
      >
        <p>禁用后该程序不会随 Windows 自动启动，需要时仍可正常手动打开，不影响软件功能。</p>
        {pendingDisable ? (
          <div className="confirm-list">
            <div className="confirm-list-item">
              <span>启动来源</span>
              <b>{pendingDisable.sourceLabel}</b>
            </div>
            <div className="confirm-list-item">
              <span>影响程度</span>
              <b>{IMPACT_META[pendingDisable.impact].label}</b>
            </div>
          </div>
        ) : null}
        <p className="modal-note">该操作可逆，禁用项会保留在列表中，可随时重新启用。</p>
      </ConfirmDialog>
    </div>
  )
}
