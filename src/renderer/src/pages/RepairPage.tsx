import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  FileWarning,
  Globe2,
  History,
  Loader2,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle
} from 'lucide-react'
import type {
  PageId,
  RepairCategory,
  RepairCheck,
  RepairFixResult,
  RepairIssue,
  RepairReport,
  RiskEvent,
  RiskEventKind
} from '@shared/types'
import { ScoreGauge } from '../components/ScoreGauge'
import { Button, Card, Chip, ConfirmDialog, EmptyState, Skeleton } from '../components/ui'
import { useToast } from '../components/Toast'
import { cx, errorMessage, timeAgo } from '../lib/format'

type CategoryFilter = 'all' | RepairCategory
type PendingFix = { issues: RepairIssue[]; risky: boolean; mode: 'single' | 'bulk' }

const CATEGORY_LABELS: Record<RepairCategory, string> = {
  security: '安全防护',
  network: '网络设置',
  service: '系统服务',
  system: '系统文件',
  shortcut: '快捷方式'
}

const CATEGORY_FILTERS: Array<{ id: CategoryFilter; label: string }> = [
  { id: 'all', label: '全部问题' },
  { id: 'security', label: '安全防护' },
  { id: 'network', label: '网络设置' },
  { id: 'service', label: '系统服务' },
  { id: 'system', label: '系统文件' },
  { id: 'shortcut', label: '快捷方式' }
]

const SEVERITY_META = {
  high: { label: '高风险', tone: 'red' },
  medium: { label: '中风险', tone: 'amber' },
  low: { label: '低风险', tone: 'gray' }
} as const

const RISK_KIND_LABELS: Record<RiskEventKind, string> = {
  'process-end': '进程结束',
  'network-change': '网络修改',
  'system-repair': '系统修复'
}

function CheckIcon({ check }: { check: RepairCheck }): React.JSX.Element {
  if (check.status === 'ok') return <CheckCircle2 size={16} className="repair-check-ok" />
  if (check.status === 'danger') return <ShieldAlert size={16} className="repair-check-danger" />
  if (check.status === 'issue') return <AlertTriangle size={16} className="repair-check-warn" />
  return <CircleDashed size={16} className="repair-check-skip" />
}

function severityIcon(issue: RepairIssue): React.ReactNode {
  if (issue.severity === 'high') return <ShieldAlert size={18} />
  if (issue.severity === 'medium') return <AlertTriangle size={18} />
  return <FileWarning size={18} />
}

export function RepairPage({ onNavigate }: { onNavigate?: (page: PageId) => void }): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [report, setReport] = useState<RepairReport | null>(null)
  const [riskEvents, setRiskEvents] = useState<RiskEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingFix | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [relaunching, setRelaunching] = useState(false)
  const [lastFix, setLastFix] = useState<RepairFixResult | null>(null)

  const runScan = async (showToast: boolean): Promise<void> => {
    setScanning(true)
    setError(null)
    try {
      const data = await api.repair.scan(true)
      setReport(data)
      setRiskEvents(data.riskEvents)
      setSelected(new Set())
      if (showToast) {
        toast.push(
          data.issues.length > 0 ? 'info' : 'success',
          data.issues.length > 0 ? `检测完成，发现 ${data.issues.length} 项需要关注` : '检测完成，系统状态良好'
        )
      }
    } catch (scanError) {
      const message = errorMessage(scanError)
      setError(message)
      toast.push('error', message)
    } finally {
      setScanning(false)
      setLoading(false)
    }
  }

  useEffect(() => {
    let alive = true
    api.repair
      .last()
      .then((last) => {
        if (!alive) return
        if (last) {
          setReport(last)
          setRiskEvents(last.riskEvents)
          setLoading(false)
        } else {
          void runScan(false)
        }
      })
      .catch(() => {
        if (alive) void runScan(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const issues = report?.issues ?? []
  const checks = report?.checks ?? []
  const isAdmin = report?.isAdmin === true

  const safeIssues = useMemo(
    () => issues.filter((issue) => issue.fixId && !issue.risky && (!issue.requiresAdmin || isAdmin)),
    [issues, isAdmin]
  )
  const riskyIssues = useMemo(() => issues.filter((issue) => issue.risky), [issues])
  const highCount = issues.filter((issue) => issue.severity === 'high').length
  const okChecks = checks.filter((check) => check.status === 'ok').length
  const adminNeeded = issues.filter((issue) => issue.requiresAdmin && !isAdmin).length

  const filtered = useMemo(
    () => issues.filter((issue) => filter === 'all' || issue.category === filter),
    [issues, filter]
  )

  const countFor = (id: CategoryFilter): number =>
    issues.filter((issue) => id === 'all' || issue.category === id).length

  const toggleOne = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const requestFix = (targets: RepairIssue[], risky: boolean, mode: PendingFix['mode']): void => {
    if (targets.length === 0) {
      toast.push('info', '没有可自动修复的项目')
      return
    }
    setAck(false)
    setPending({ issues: targets, risky, mode })
  }

  const applyFix = async (): Promise<void> => {
    if (!pending || busy) return
    setBusy(true)
    try {
      const outcome = await api.repair.fix(pending.issues.map((issue) => issue.id))
      setReport(outcome.report)
      setRiskEvents(outcome.report.riskEvents)
      setLastFix(outcome)
      setSelected(new Set())
      toast.push(outcome.result.ok ? 'success' : 'error', outcome.result.message)
    } catch (fixError) {
      toast.push('error', errorMessage(fixError))
    } finally {
      setBusy(false)
      setPending(null)
      setAck(false)
    }
  }

  const relaunch = async (): Promise<void> => {
    if (relaunching) return
    setRelaunching(true)
    try {
      const outcome = await api.app.relaunchAsAdmin()
      toast.push(outcome.ok ? 'success' : 'error', outcome.message)
    } catch (relaunchError) {
      toast.push('error', errorMessage(relaunchError))
    } finally {
      setRelaunching(false)
    }
  }

  const loadMoreRisk = async (): Promise<void> => {
    try {
      const events = await api.repair.riskLog(20)
      setRiskEvents(events)
      toast.push('info', events.length > 0 ? `已加载最近 ${events.length} 条危险操作记录` : '暂时没有危险操作记录')
    } catch (logError) {
      toast.push('error', errorMessage(logError))
    }
  }

  const heroTitle = !report
    ? '正在准备系统修复检测'
    : highCount > 0
      ? `发现 ${highCount} 项高风险问题`
      : issues.length > 0
        ? `发现 ${issues.length} 项可优化项`
        : '系统状态良好'
  const heroDescription = !report
    ? '检测安全防护、网络设置、系统服务与关键文件，全程只读，不会修改任何配置。'
    : issues.length === 0
      ? '安全防护、网络解析、系统服务与快捷方式均未发现异常。建议定期检测。'
      : '建议优先处理高风险项；修复前会自动备份原设置，危险操作会记录到日志中。'

  const pendingSafe = safeIssues.filter((issue) => issue.fixId)
  const pendingRisky = pending?.issues.some((issue) => issue.risky) === true
  const pendingCategories = [...new Set(pending?.issues.map((issue) => CATEGORY_LABELS[issue.category]))]

  return (
    <div className="page repair-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">系统修复</h1>
          <p className="page-subtitle">检查安全配置、网络劫持、系统服务与文件异常，并为每一项修复保留备份与操作记录</p>
        </div>
        <div className="page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={scanning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            onClick={() => void runScan(true)}
            disabled={scanning || busy}
          >
            {scanning ? '检测中…' : '重新检测'}
          </Button>
        </div>
      </div>

      {!isAdmin && report ? (
        <div className="admin-banner">
          <span className="admin-banner-icon">
            <ShieldAlert size={18} />
          </span>
          <div>
            <b>部分修复需要管理员权限</b>
            <p>
              当前有 {adminNeeded} 项问题需要管理员权限才能修复。检测与安全项修复可以正常进行，建议以管理员身份重新启动后再处理系统级问题。
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={relaunching ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
            onClick={() => void relaunch()}
            disabled={relaunching}
          >
            {relaunching ? '正在重启…' : '以管理员身份重启'}
          </Button>
        </div>
      ) : null}

      {highCount > 0 ? (
        <div className="repair-risk-banner">
          <span className="repair-risk-icon">
            <ShieldAlert size={19} />
          </span>
          <div>
            <b>发现 {highCount} 项高风险问题</b>
            <p>
              涉及 {[...new Set(issues.filter((issue) => issue.severity === 'high').map((issue) => CATEGORY_LABELS[issue.category]))].join('、')}
              ，可能影响系统安全或正常更新。请优先处理标红项目。
            </p>
          </div>
          {pendingSafe.length > 0 ? (
            <Button
              variant="danger"
              size="sm"
              icon={<Wrench size={15} />}
              onClick={() => requestFix(pendingSafe, false, 'bulk')}
              disabled={busy || scanning}
            >
              修复安全项
            </Button>
          ) : null}
        </div>
      ) : null}

      <Card className="repair-hero">
        <div className="repair-hero-gauge">
          <ScoreGauge value={scanning ? 0 : report?.score ?? null} mode={scanning ? 'progress' : 'score'} caption="系统健康评分" />
        </div>
        <div className="repair-hero-copy">
          <span className="repair-kicker">
            <Wrench size={15} />
            {scanning ? '正在检测系统配置…' : report ? `上次检测 ${timeAgo(report.scannedAt)}` : '等待检测'}
          </span>
          <h2>{scanning ? '正在扫描系统…' : heroTitle}</h2>
          <p>{scanning ? '正在读取安全策略、服务状态、hosts 与快捷方式，请保持程序运行。' : heroDescription}</p>
          <div className="repair-hero-actions">
            <Button
              variant="primary"
              icon={<Sparkles size={16} />}
              onClick={() => requestFix(pendingSafe, false, 'bulk')}
              disabled={scanning || busy || pendingSafe.length === 0 || !report}
            >
              一键修复安全项
            </Button>
            <Button
              variant="secondary"
              icon={scanning ? <Loader2 size={15} className="spin" /> : <ScanLine size={16} />}
              onClick={() => void runScan(true)}
              disabled={scanning || busy}
            >
              {scanning ? '检测中…' : '重新检测'}
            </Button>
          </div>
        </div>
        <div className="repair-hero-stats">
          <div className="repair-stat">
            <span>检测项目</span>
            <b>{scanning ? '—' : checks.length}</b>
          </div>
          <div className="repair-stat">
            <span>状态正常</span>
            <b className="is-ok">{scanning ? '—' : okChecks}</b>
          </div>
          <div className="repair-stat">
            <span>待处理</span>
            <b className={cx(issues.length > 0 && 'is-warn')}>{scanning ? '—' : issues.length}</b>
          </div>
          <div className="repair-stat">
            <span>危险操作记录</span>
            <b>{riskEvents.length}</b>
          </div>
        </div>
      </Card>

      {error ? (
        <div className="inline-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => void runScan(true)}>
            重试
          </button>
        </div>
      ) : null}

      {lastFix && (lastFix.failed.length > 0 || lastFix.rebootRequired) ? (
        <Card className="repair-result-card">
          <div className="card-head">
            <div>
              <h3>最近一次修复结果</h3>
              <p>
                成功 {lastFix.fixed.length} 项
                {lastFix.failed.length > 0 ? ` · 失败 ${lastFix.failed.length} 项` : ''}
                {lastFix.rebootRequired ? ' · 部分设置重启后生效' : ''}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setLastFix(null)}>
              收起
            </Button>
          </div>
          {lastFix.failed.length > 0 ? (
            <div className="repair-fail-list">
              {lastFix.failed.map((item) => (
                <div className="repair-fail-row" key={item.id}>
                  <XCircle size={15} />
                  <b>{item.title}</b>
                  <span>{item.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="repair-result-note">所有修复已完成，部分系统设置需要重启电脑后生效。</p>
          )}
        </Card>
      ) : null}

      <div className="repair-grid">
        <div className="repair-main">
          <Card className="repair-list-card">
            <div className="repair-list-head">
              <div className="filter-tabs" role="group" aria-label="筛选修复问题">
                {CATEGORY_FILTERS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cx('filter-tab', filter === item.id && 'filter-tab-active')}
                    onClick={() => setFilter(item.id)}
                  >
                    {item.label}
                    <span className="filter-tab-count">{report ? countFor(item.id) : '—'}</span>
                  </button>
                ))}
              </div>
              {safeIssues.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set(safeIssues.map((issue) => issue.id)))}
                >
                  全选安全项
                </Button>
              ) : null}
            </div>

            {loading || scanning ? (
              <div className="repair-issue-list">
                {[0, 1, 2, 3].map((row) => (
                  <div className="repair-issue-skeleton" key={row}>
                    <Skeleton className="skeleton-icon" />
                    <div className="skeleton-copy">
                      <Skeleton className="skeleton-line" />
                      <Skeleton className="skeleton-line short" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length > 0 ? (
              <div className="repair-issue-list">
                {filtered.map((issue) => {
                  const severity = SEVERITY_META[issue.severity]
                  const safe = Boolean(issue.fixId) && !issue.risky && (!issue.requiresAdmin || isAdmin)
                  const adminBlocked = issue.requiresAdmin && !isAdmin
                  return (
                    <div className={cx('repair-issue', `repair-issue-${issue.severity}`)} key={issue.id}>
                      <div className="repair-issue-select">
                        {safe ? (
                          <input
                            type="checkbox"
                            checked={selected.has(issue.id)}
                            aria-label={`选择 ${issue.title}`}
                            onChange={() => toggleOne(issue.id)}
                          />
                        ) : (
                          <span className={cx('repair-issue-icon', `repair-icon-${issue.severity}`)}>
                            {severityIcon(issue)}
                          </span>
                        )}
                      </div>
                      <div className="repair-issue-copy">
                        <div className="repair-issue-title">
                          <b>{issue.title}</b>
                          <Chip tone={severity.tone}>{severity.label}</Chip>
                          <Chip tone="gray">{CATEGORY_LABELS[issue.category]}</Chip>
                          {issue.risky ? <Chip tone="amber">需二次确认</Chip> : null}
                          {issue.needsReboot ? <Chip tone="blue">需重启</Chip> : null}
                        </div>
                        <p className="repair-issue-detail">{issue.detail}</p>
                        {issue.evidence.length > 0 ? (
                          <div className="repair-evidence">
                            {issue.evidence.slice(0, 3).map((line) => (
                              <code key={line}>{line}</code>
                            ))}
                          </div>
                        ) : null}
                        <p className="repair-issue-note">{issue.note}</p>
                      </div>
                      <div className="repair-issue-op">
                        <span className="repair-issue-metric">{issue.metric}</span>
                        {issue.fixId ? (
                          adminBlocked ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={<ShieldCheck size={14} />}
                              onClick={() => toast.push('info', '该修复需要管理员权限，请以管理员身份重新启动后再试')}
                            >
                              需管理员
                            </Button>
                          ) : (
                            <Button
                              variant={issue.risky ? 'danger' : 'secondary'}
                              size="sm"
                              icon={issue.risky ? <ShieldAlert size={14} /> : <Wrench size={14} />}
                              onClick={() => requestFix([issue], issue.risky, 'single')}
                              disabled={busy}
                            >
                              {issue.fixLabel ?? '立即修复'}
                            </Button>
                          )
                        ) : issue.page && onNavigate ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onNavigate(issue.page as PageId)}
                          >
                            {issue.fixLabel ?? '去处理'}
                            <ChevronRight size={14} />
                          </Button>
                        ) : (
                          <Chip tone="gray">需手动处理</Chip>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <EmptyState
                icon={<ShieldCheck size={26} />}
                title={report ? '没有发现需要处理的问题' : '等待检测结果'}
                description={
                  filter === 'all'
                    ? '安全防护、网络解析、系统服务与快捷方式均处于正常状态。'
                    : '该分类下没有异常，切换其他分类查看。'
                }
                action={
                  filter !== 'all' ? (
                    <Button variant="secondary" size="sm" onClick={() => setFilter('all')}>
                      查看全部
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => void runScan(true)} loading={scanning}>
                      重新检测
                    </Button>
                  )
                }
              />
            )}

            {selected.size > 0 ? (
              <div className="repair-selection-bar">
                <span>
                  已选择 <b>{selected.size}</b> 项安全修复
                </span>
                <div>
                  <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                    取消选择
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Wrench size={14} />}
                    onClick={() => requestFix(safeIssues.filter((issue) => selected.has(issue.id)), false, 'bulk')}
                    disabled={busy}
                  >
                    修复所选
                  </Button>
                </div>
              </div>
            ) : (
              <div className="repair-notice">
                <ShieldCheck size={15} />
                <span>
                  检测过程只读取系统状态。修复前会自动备份原设置，管理员权限不足的项目会明确标注，不会静默跳过。
                  {riskyIssues.length > 0 ? ` 当前有 ${riskyIssues.length} 项高风险修复需要二次确认。` : ''}
                </span>
              </div>
            )}
          </Card>

          <Card className="repair-checks-card">
            <div className="card-head">
              <div>
                <h3>检测项目</h3>
                <p>{report ? `覆盖 ${checks.length} 项系统配置与安全策略` : '完成检测后显示每一项的检查结果'}</p>
              </div>
              {report ? <Chip tone={okChecks === checks.length ? 'green' : 'amber'}>{okChecks}/{checks.length} 正常</Chip> : null}
            </div>
            {loading || scanning ? (
              <div className="repair-checks">
                {[0, 1, 2, 3, 4].map((row) => (
                  <div className="repair-check-row" key={row}>
                    <Skeleton className="skeleton-icon" />
                    <Skeleton className="skeleton-line" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="repair-checks">
                {checks.map((check) => (
                  <div className="repair-check-row" key={check.id}>
                    <CheckIcon check={check} />
                    <div>
                      <b>{check.label}</b>
                      <span>{check.detail}</span>
                    </div>
                    <Chip
                      tone={
                        check.status === 'ok'
                          ? 'green'
                          : check.status === 'danger'
                            ? 'red'
                            : check.status === 'issue'
                              ? 'amber'
                              : 'gray'
                      }
                    >
                      {check.status === 'ok'
                        ? '正常'
                        : check.status === 'danger'
                          ? '高风险'
                          : check.status === 'issue'
                            ? '待处理'
                            : '未检测'}
                    </Chip>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <aside className="repair-side">
          <Card className="repair-risk-card">
            <div className="card-head">
              <div>
                <h3>
                  <span className="repair-risk-title-icon">
                    <History size={15} />
                  </span>
                  危险操作日志
                </h3>
                <p>结束进程、修改网络与系统级修复都会记录</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void loadMoreRisk()}>
                加载更多
              </Button>
            </div>
            {riskEvents.length > 0 ? (
              <div className="risk-log">
                {riskEvents.map((event) => (
                  <div className="risk-log-item" key={event.id}>
                    <span className={cx('risk-log-dot', `risk-dot-${event.severity}`)} />
                    <div className="risk-log-copy">
                      <b>{event.title}</b>
                      <span>{event.detail}</span>
                      <span className="risk-log-meta">
                        {RISK_KIND_LABELS[event.kind]} · {timeAgo(event.at)}
                      </span>
                    </div>
                    <Chip tone={SEVERITY_META[event.severity].tone}>{SEVERITY_META[event.severity].label}</Chip>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<History size={24} />}
                title="暂无危险操作记录"
                description="执行系统修复、结束进程或修改网络后，这里会留下可追溯的记录。"
              />
            )}
          </Card>

          <Card className="repair-guide-card">
            <div className="repair-guide-head">
              <span className="repair-guide-icon">
                <Sparkles size={17} />
              </span>
              <div>
                <h3>修复原则</h3>
                <p>安全、可逆、可追溯</p>
              </div>
            </div>
            <ul className="repair-guide-list">
              <li>
                <ShieldCheck size={14} />
                修改注册表、hosts、服务与快捷方式前，先备份原状态。
              </li>
              <li>
                <ShieldAlert size={14} />
                高风险操作需要勾选确认，管理员权限不足时明确提示。
              </li>
              <li>
                <Globe2 size={14} />
                Winsock 重置等操作需要重启，不会强制重启电脑。
              </li>
              <li>
                <ScanLine size={14} />
                检测只读取本机状态，不会上传任何系统信息。
              </li>
            </ul>
          </Card>
        </aside>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => {
          if (!busy) {
            setPending(null)
            setAck(false)
          }
        }}
        onConfirm={() => void applyFix()}
        title={
          pending?.mode === 'single'
            ? `修复「${pending.issues[0]?.title ?? ''}」？`
            : `修复 ${pending?.issues.length ?? 0} 项安全问题？`
        }
        confirmText={pendingRisky ? '确认并修复' : '开始修复'}
        tone={pendingRisky ? 'danger' : 'amber'}
        busy={busy}
        confirmDisabled={pendingRisky && !ack}
        icon={pendingRisky ? <ShieldAlert size={22} /> : <Wrench size={22} />}
      >
        <p>
          {pending?.issues.length === 1
            ? pending.issues[0].detail
            : `将修复 ${pendingCategories.join('、')} 分类下的 ${pending?.issues.length ?? 0} 项问题，均为可直接处理的安全项。`}
        </p>
        <div className="confirm-list">
          {pending?.issues.slice(0, 5).map((issue) => (
            <div className="confirm-list-item" key={issue.id}>
              <span>{issue.title}</span>
              <b>{issue.fixLabel ?? '修复'}</b>
            </div>
          ))}
          {pending && pending.issues.length > 5 ? (
            <div className="confirm-list-item">
              <span>其余 {pending.issues.length - 5} 项</span>
              <b>—</b>
            </div>
          ) : null}
        </div>
        {pending?.issues.some((issue) => issue.needsReboot) ? (
          <p className="modal-note">部分修复需要重启电脑后才能生效，程序不会自动重启。</p>
        ) : null}
        <p className="modal-note">修复前会备份原设置，危险操作会写入日志。</p>
        {pendingRisky ? (
          <label className="danger-ack">
            <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
            我了解该操作会修改系统设置，并确认现在修复
          </label>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
