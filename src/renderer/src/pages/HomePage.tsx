import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircuitBoard,
  HardDrive,
  Lightbulb,
  MemoryStick,
  Package,
  Rocket,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wrench
} from 'lucide-react'
import type {
  HealthIssue,
  HealthProgress,
  HealthReport,
  PageId,
  SystemSnapshot
} from '@shared/types'
import { ScoreGauge } from '../components/ScoreGauge'
import { Button, Card, ProgressBar } from '../components/ui'
import { useToast } from '../components/Toast'
import {
  cx,
  errorMessage,
  formatBytes,
  formatClock,
  timeAgo,
  usagePercent
} from '../lib/format'

type RowStatus = 'ok' | 'warn' | 'danger' | 'idle'

const STAGES: Array<HealthProgress['stage']> = ['system', 'junk', 'startup', 'protection', 'score']
const STAGE_LABELS: Record<HealthProgress['stage'], string> = {
  system: '系统状态',
  junk: '垃圾文件',
  startup: '启动项',
  protection: '安全防护',
  score: '综合评分'
}

function worstIssue(issueMap: Map<string, HealthIssue>, ids: string[]): HealthIssue | undefined {
  const order = { high: 0, medium: 1, low: 2 }
  return ids
    .map((id) => issueMap.get(id))
    .filter((issue): issue is HealthIssue => Boolean(issue))
    .sort((a, b) => order[a.severity] - order[b.severity])[0]
}

function statusFromIssue(issue?: HealthIssue): RowStatus {
  if (!issue) return 'ok'
  if (issue.severity === 'high') return 'danger'
  return 'warn'
}

function StatusIcon({ status, size = 16 }: { status: RowStatus; size?: number }): React.JSX.Element {
  if (status === 'ok') return <CheckCircle2 size={size} />
  if (status === 'danger') return <ShieldAlert size={size} />
  if (status === 'warn') return <AlertTriangle size={size} />
  return <CircleDashed size={size} />
}

interface CheckRowData {
  key: string
  title: string
  icon: React.ReactNode
  detail: string
  metric: string
  status: RowStatus
  actionPage: PageId | null
  actionLabel: string | null
}

export function HomePage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [report, setReport] = useState<HealthReport | null>(null)
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<HealthProgress | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    const unsubscribe = api.health.onProgress((next) => {
      if (alive) setProgress(next)
    })
    Promise.allSettled([api.health.last(), api.system.snapshot()]).then(([last, system]) => {
      if (!alive) return
      if (last.status === 'fulfilled' && last.value) setReport(last.value)
      if (system.status === 'fulfilled') setSnapshot(system.value)
      setLoaded(true)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])

  const runCheck = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setProgress({ stage: 'system', label: '正在准备体检…', percent: 2 })
    try {
      const result = await api.health.run()
      setReport(result)
      setSnapshot(result.snapshot)
      toast.push(
        'success',
        result.issues.length > 0 ? `体检完成，发现 ${result.issues.length} 项优化建议` : '体检完成，电脑状态优秀'
      )
    } catch (error) {
      toast.push('error', errorMessage(error))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const liveSnapshot = report?.snapshot ?? snapshot
  const issueMap = useMemo(() => new Map((report?.issues ?? []).map((issue) => [issue.id, issue])), [report])

  const memoryPercent = liveSnapshot?.memoryPercent ?? 0
  const systemDisk =
    liveSnapshot?.disks.find((disk) => disk.id.toUpperCase().startsWith('C:')) ?? liveSnapshot?.disks[0]
  const diskUsage = systemDisk ? usagePercent(systemDisk.free, systemDisk.total) : 0
  const defenderOn = liveSnapshot?.defender.available === true && liveSnapshot.defender.realtime
  const defenderKnown = liveSnapshot?.defender.available === true
  const gaugeValue = running ? progress?.percent ?? 0 : report?.score ?? null

  const heroTitle = running
    ? '正在为电脑做全面体检'
    : !report
      ? '让电脑保持轻快安全'
      : report.score >= 90
        ? '电脑状态优秀'
        : report.score >= 70
          ? '电脑状态良好，仍有优化空间'
          : '发现较多问题，建议尽快处理'
  const heroSubtitle = running
    ? progress?.label || '正在检查系统状态…'
    : report
      ? `上次体检 ${timeAgo(report.checkedAt)}，共检查 6 个项目`
      : '一键检查垃圾文件、启动项、防护状态与查杀记录，全程约需 10 秒。'
  const heroBadge = running
    ? '全面体检中'
    : !report
      ? '待体检'
      : report.issues.length === 0
        ? '状态优秀'
        : `${report.issues.length} 项可优化`
  const scoreNote = running
    ? '请保持程序运行'
    : report
      ? report.score >= 90
        ? '各项指标正常'
        : '按建议处理可提升评分'
      : '推荐每周体检一次'

  const currentStageIndex = progress ? STAGES.indexOf(progress.stage) : -1

  const checks: CheckRowData[] = useMemo(() => {
    if (!report) {
      return [
        {
          key: 'junk',
          title: '垃圾清理',
          icon: <Trash2 size={17} />,
          detail: '检查临时文件、浏览器缓存与系统残留',
          metric: '待检测',
          status: 'idle',
          actionPage: null,
          actionLabel: null
        },
        {
          key: 'startup',
          title: '开机启动',
          icon: <Rocket size={17} />,
          detail: '检查随系统启动的程序数量与开销',
          metric: '待检测',
          status: 'idle',
          actionPage: null,
          actionLabel: null
        },
        {
          key: 'memory',
          title: '内存占用',
          icon: <MemoryStick size={17} />,
          detail: '查看当前内存使用情况',
          metric: '待检测',
          status: 'idle',
          actionPage: null,
          actionLabel: null
        },
        {
          key: 'disk',
          title: '磁盘空间',
          icon: <HardDrive size={17} />,
          detail: '检查系统盘可用空间是否充足',
          metric: '待检测',
          status: 'idle',
          actionPage: null,
          actionLabel: null
        },
        {
          key: 'protection',
          title: '安全防护',
          icon: <ShieldCheck size={17} />,
          detail: '读取 Windows Defender 实时防护状态',
          metric: '待检测',
          status: 'idle',
          actionPage: null,
          actionLabel: null
        },
        {
          key: 'scan',
          title: '病毒查杀',
          icon: <ScanLine size={17} />,
          detail: '检查上次查杀结果与风险处理情况',
          metric: '待检测',
          status: 'idle',
          actionPage: null,
          actionLabel: null
        }
      ]
    }

    const junkIssue = worstIssue(issueMap, ['junk'])
    const startupIssue = worstIssue(issueMap, ['startup'])
    const memoryIssue = worstIssue(issueMap, ['memory'])
    const diskIssue = worstIssue(issueMap, ['disk'])
    const protectionIssue = worstIssue(issueMap, ['protection', 'protection-status'])
    const scanIssue = worstIssue(issueMap, ['threats', 'scan', 'scan-cancelled'])
    const diskFreePercent = systemDisk ? 100 - diskUsage : 0

    return [
      {
        key: 'junk',
        title: '垃圾清理',
        icon: <Trash2 size={17} />,
        detail: junkIssue?.detail ?? (report.junkBytes > 0 ? `共 ${report.junkFiles} 个文件，占用空间较少` : '没有需要清理的垃圾文件'),
        metric: junkIssue?.metric ?? formatBytes(report.junkBytes),
        status: statusFromIssue(junkIssue),
        actionPage: junkIssue?.actionPage ?? null,
        actionLabel: junkIssue?.actionLabel ?? null
      },
      {
        key: 'startup',
        title: '开机启动',
        icon: <Rocket size={17} />,
        detail: startupIssue?.detail ?? '启动项数量处于合理范围',
        metric: startupIssue?.metric ?? `${report.startupCount} 项`,
        status: statusFromIssue(startupIssue),
        actionPage: startupIssue?.actionPage ?? null,
        actionLabel: startupIssue?.actionLabel ?? null
      },
      {
        key: 'memory',
        title: '内存占用',
        icon: <MemoryStick size={17} />,
        detail: memoryIssue?.detail ?? '内存占用在正常范围内',
        metric: memoryIssue?.metric ?? `${memoryPercent}%`,
        status: statusFromIssue(memoryIssue),
        actionPage: null,
        actionLabel: null
      },
      {
        key: 'disk',
        title: '磁盘空间',
        icon: <HardDrive size={17} />,
        detail: diskIssue?.detail ?? '系统盘可用空间充足',
        metric: diskIssue?.metric ?? `${diskFreePercent.toFixed(0)}% 可用`,
        status: statusFromIssue(diskIssue),
        actionPage: null,
        actionLabel: null
      },
      {
        key: 'protection',
        title: '安全防护',
        icon: <ShieldCheck size={17} />,
        detail:
          protectionIssue?.detail ??
          (defenderOn ? 'Windows Defender 实时保护工作正常' : '未能读取实时防护状态'),
        metric: protectionIssue?.metric ?? (defenderOn ? '实时防护已开启' : '未知'),
        status: statusFromIssue(protectionIssue),
        actionPage: null,
        actionLabel: null
      },
      {
        key: 'scan',
        title: '病毒查杀',
        icon: <ScanLine size={17} />,
        detail:
          scanIssue?.detail ??
          (report.lastScanAt ? `上次查杀 ${timeAgo(report.lastScanAt)}，未发现未处理风险` : '建议完成一次全盘查杀'),
        metric: scanIssue?.metric ?? (report.lastScanAt ? timeAgo(report.lastScanAt) : '从未查杀'),
        status: statusFromIssue(scanIssue),
        actionPage: scanIssue?.actionPage ?? null,
        actionLabel: scanIssue?.actionLabel ?? null
      }
    ]
  }, [report, issueMap, defenderOn, memoryPercent, systemDisk, diskUsage])

  const quickActions: Array<{
    page: PageId
    title: string
    description: string
    icon: React.ReactNode
    tone: string
  }> = [
    {
      page: 'virus',
      title: '木马查杀',
      description: report && report.threatCount > 0 ? `${report.threatCount} 个风险待处理` : '查杀并隔离风险',
      icon: <ShieldCheck size={20} />,
      tone: 'green'
    },
    {
      page: 'junk',
      title: '垃圾清理',
      description: report ? `${formatBytes(report.junkBytes)} 可清理` : '释放磁盘空间',
      icon: <Trash2 size={20} />,
      tone: 'blue'
    },
    {
      page: 'software',
      title: '软件管家',
      description: '安装、卸载与升级',
      icon: <Package size={20} />,
      tone: 'amber'
    },
    {
      page: 'startup',
      title: '加速中心',
      description: report ? `${report.startupCount} 个启动项` : '开机与性能加速',
      icon: <Rocket size={20} />,
      tone: 'violet'
    },
    {
      page: 'repair',
      title: '系统修复',
      description: '修复系统异常与高危配置',
      icon: <Wrench size={20} />,
      tone: 'blue'
    },
    {
      page: 'drivers',
      title: '驱动管理',
      description: '检查驱动状态与更新',
      icon: <CircuitBoard size={20} />,
      tone: 'amber'
    }
  ]

  return (
    <div className="page home-page">
      <div className="home-intro">
        <div>
          <h1>安全概览</h1>
          <p>
            {liveSnapshot
              ? `${liveSnapshot.hostname} · ${liveSnapshot.osName} ${liveSnapshot.arch}`
              : loaded
                ? '暂时无法读取系统信息'
                : '正在读取系统信息…'}
          </p>
        </div>
        <div className="home-intro-meta">
          <span className={cx('status-pill', defenderOn ? 'status-pill-ok' : 'status-pill-neutral')}>
            <span className="live-dot" />
            {defenderKnown ? (defenderOn ? '实时防护运行中' : '实时防护未开启') : '防护状态读取中'}
          </span>
          <span className="home-time">今日 {new Date().toLocaleDateString('zh-CN')}</span>
        </div>
      </div>

      <section className={cx('home-hero', running && 'home-hero-running')}>
        <div className="hero-visual">
          <ScoreGauge value={gaugeValue} mode={running ? 'progress' : 'score'} />
          <span className="hero-gauge-note">{scoreNote}</span>
        </div>

        <div className="hero-copy">
          <div className="hero-eyebrow">
            <span className={cx('hero-badge', running && 'hero-badge-running', report?.score !== undefined && report.score < 70 && !running && 'hero-badge-warn')}>
              {running ? <span className="spinner-dot" /> : <ShieldCheck size={13} />}
              {heroBadge}
            </span>
            {report ? <span className="hero-last">上次体检 {formatClock(report.checkedAt)}</span> : null}
          </div>
          <h2>{heroTitle}</h2>
          <p className="hero-subtitle">{heroSubtitle}</p>

          {running ? (
            <div className="hero-progress">
              <div className="hero-progress-head">
                <span>{progress?.label || '正在体检…'}</span>
                <b>{progress?.percent ?? 0}%</b>
              </div>
              <ProgressBar value={progress?.percent ?? 0} striped />
              <div className="scan-steps">
                {STAGES.map((stage, index) => (
                  <span
                    key={stage}
                    className={cx(
                      'scan-step',
                      index < currentStageIndex && 'scan-step-done',
                      index === currentStageIndex && 'scan-step-active'
                    )}
                  >
                    {index < currentStageIndex ? <CheckCircle2 size={13} /> : <span className="scan-step-dot" />}
                    {STAGE_LABELS[stage]}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="hero-actions">
                <Button variant="primary" size="lg" icon={<ScanLine size={18} />} onClick={runCheck}>
                  {report ? '重新体检' : '立即体检'}
                </Button>
                <Button variant="secondary" size="lg" icon={<ShieldCheck size={17} />} onClick={() => onNavigate('virus')}>
                  木马查杀
                </Button>
              </div>
              {report && report.issues.length === 0 ? (
                <div className="hero-safe-note">
                  <CheckCircle2 size={15} />
                  未发现需要处理的问题
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="hero-stats">
          <div className="hero-stat">
            <div className="hero-stat-head">
              <span className="hero-stat-name">
                <span className="stat-icon stat-icon-blue">
                  <MemoryStick size={15} />
                </span>
                内存占用
              </span>
              <b>{liveSnapshot ? `${memoryPercent}%` : '—'}</b>
            </div>
            <ProgressBar
              value={memoryPercent}
              size="sm"
              tone={memoryPercent >= 85 ? 'red' : memoryPercent >= 70 ? 'amber' : 'blue'}
            />
            <div className="hero-stat-sub">
              {liveSnapshot
                ? `${formatBytes(liveSnapshot.memoryUsed)} / ${formatBytes(liveSnapshot.memoryTotal)}`
                : '读取中…'}
            </div>
          </div>

          <div className="hero-stat">
            <div className="hero-stat-head">
              <span className="hero-stat-name">
                <span className="stat-icon stat-icon-amber">
                  <HardDrive size={15} />
                </span>
                {systemDisk ? `系统盘 ${systemDisk.id.replace(':', '')}` : '磁盘空间'}
              </span>
              <b>{systemDisk ? `${diskUsage}%` : '—'}</b>
            </div>
            <ProgressBar value={diskUsage} size="sm" tone={diskUsage >= 90 ? 'red' : diskUsage >= 80 ? 'amber' : 'brand'} />
            <div className="hero-stat-sub">
              {systemDisk ? `可用 ${formatBytes(systemDisk.free)} / ${formatBytes(systemDisk.total)}` : '读取中…'}
            </div>
          </div>

          <div className="hero-stat hero-stat-protection">
            <div className="hero-stat-head">
              <span className="hero-stat-name">
                <span className={cx('stat-icon', defenderOn ? 'stat-icon-green' : 'stat-icon-gray')}>
                  <ShieldCheck size={15} />
                </span>
                实时防护
              </span>
              <span className={cx('protection-state', defenderOn ? 'is-on' : 'is-off')}>
                <span />
                {defenderKnown ? (defenderOn ? '已开启' : '未开启') : '未知'}
              </span>
            </div>
            <div className="hero-stat-sub">
              {liveSnapshot?.defender.signatureVersion
                ? `病毒库 ${liveSnapshot.defender.signatureVersion}`
                : '由 Windows Defender 提供'}
            </div>
          </div>
        </div>
      </section>

      <div className="home-grid">
        <Card className="checks-card">
          <div className="card-head">
            <div>
              <h3>体检项目</h3>
              <p>{report ? `检查于 ${timeAgo(report.checkedAt)}` : '完成体检后这里会显示每一项的状态'}</p>
            </div>
            {report ? <span className="card-head-score">综合评分 <b>{report.score}</b></span> : null}
          </div>
          <div className="check-list">
            {checks.map((row) => (
              <div className="check-row" key={row.key}>
                <span className={cx('check-status-icon', `status-${row.status}`)}>
                  <StatusIcon status={row.status} />
                </span>
                <span className="check-item-icon">{row.icon}</span>
                <div className="check-copy">
                  <div className="check-title-line">
                    <b>{row.title}</b>
                    <span className={cx('check-metric', `metric-${row.status}`)}>{row.metric}</span>
                  </div>
                  <p>{row.detail}</p>
                </div>
                {row.actionPage && row.actionLabel ? (
                  <button type="button" className="check-action" onClick={() => onNavigate(row.actionPage!)}>
                    {row.actionLabel}
                    <ChevronRight size={14} />
                  </button>
                ) : (
                  <span className={cx('check-state-text', `state-${row.status}`)}>
                    {row.status === 'idle'
                      ? '待检测'
                      : row.status === 'ok'
                        ? '正常'
                        : row.status === 'danger'
                          ? '需关注'
                          : '建议关注'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Card>

        <div className="home-side">
          <Card className="quick-card">
            <div className="card-head">
              <div>
                <h3>快捷功能</h3>
                <p>常用安全工具，一步直达</p>
              </div>
            </div>
            <div className="quick-grid">
              {quickActions.map((action) => (
                <button
                  type="button"
                  key={action.page}
                  className={cx('quick-tile', `quick-${action.tone}`)}
                  onClick={() => onNavigate(action.page)}
                >
                  <span className="quick-icon">{action.icon}</span>
                  <span className="quick-title">{action.title}</span>
                  <span className="quick-desc">{action.description}</span>
                  <ChevronRight size={15} className="quick-arrow" />
                </button>
              ))}
            </div>
          </Card>

          <div className="tips-card">
            <div className="tips-head">
              <span className="tips-icon">
                <Lightbulb size={18} />
              </span>
              <div>
                <b>安全小贴士</b>
                <span>养成好习惯，远离安全风险</span>
              </div>
            </div>
            <ul>
              <li>重要文件定期备份，勒索病毒造成的损失往往不可恢复。</li>
              <li>警惕 <code>.pdf.exe</code> 这类双扩展名文件，不要直接双击陌生附件。</li>
              <li>及时安装 Windows 更新，修补已知安全漏洞。</li>
            </ul>
            <div className="tips-foot">
              <ShieldCheck size={14} />
              扫描数据仅保存在本机
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
