import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  Square,
  Zap
} from 'lucide-react'
import type {
  PageId,
  ScanMode,
  ScanProgress,
  ScanSummary,
  ThreatItem
} from '@shared/types'
import { Button, Card, Chip, ConfirmDialog, ProgressBar } from '../components/ui'
import { useToast } from '../components/Toast'
import {
  cx,
  errorMessage,
  formatBytes,
  formatDate,
  formatDuration,
  shortPath
} from '../lib/format'

const MODES: Array<{ id: ScanMode; label: string; description: string; icon: React.ReactNode; hint: string }> = [
  {
    id: 'quick',
    label: '快速查杀',
    description: '常用位置',
    icon: <Zap size={18} />,
    hint: '扫描桌面、下载、临时目录与启动项，适合日常检查'
  },
  {
    id: 'full',
    label: '全盘查杀',
    description: '所有磁盘',
    icon: <HardDrive size={18} />,
    hint: '扫描全部本地磁盘，耗时较长，最多扫描 6 万个文件'
  },
  {
    id: 'custom',
    label: '自定义查杀',
    description: '指定目录',
    icon: <FolderOpen size={18} />,
    hint: '选择指定文件夹进行扫描，适合检查下载的软件安装包'
  }
]

const CATEGORY_META: Record<ThreatItem['category'], { label: string; tone: 'red' | 'amber' | 'blue' | 'violet' }> = {
  trojan: { label: '木马', tone: 'red' },
  malware: { label: '恶意软件', tone: 'red' },
  riskware: { label: '风险软件', tone: 'amber' },
  test: { label: '测试样本', tone: 'blue' }
}

const SEVERITY_META: Record<ThreatItem['severity'], { label: string; tone: 'red' | 'amber' | 'blue' }> = {
  high: { label: '高风险', tone: 'red' },
  medium: { label: '中风险', tone: 'amber' },
  low: { label: '低风险', tone: 'blue' }
}

export function VirusPage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [mode, setMode] = useState<ScanMode>('quick')
  const [customTarget, setCustomTarget] = useState('')
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [summary, setSummary] = useState<ScanSummary | null>(null)
  const [scanning, setScanning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [confirmSample, setConfirmSample] = useState(false)
  const [quarantining, setQuarantining] = useState(false)
  const [creatingSample, setCreatingSample] = useState(false)
  const [samplePath, setSamplePath] = useState<string | null>(null)
  const [stateLoaded, setStateLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    const unsubscribe = api.virus.onProgress((next) => {
      if (!alive) return
      setProgress(next)
      setScanning(next.running)
      if (next.phase === 'done' || next.phase === 'cancelled') {
        api.virus
          .state()
          .then((state) => {
            if (!alive) return
            setSummary(state.last)
            setScanning(false)
          })
          .catch(() => undefined)
      }
    })

    api.virus
      .state()
      .then((state) => {
        if (!alive) return
        setScanning(state.active)
        setProgress(state.progress)
        setSummary(state.last)
        if (state.progress?.mode) setMode(state.progress.mode)
        else if (state.last?.mode) setMode(state.last.mode)
        if (state.last?.mode === 'custom') setCustomTarget(state.last.target)
        setStateLoaded(true)
      })
      .catch(() => setStateLoaded(true))

    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])

  useEffect(() => {
    setSelected(new Set())
  }, [summary?.id])

  const threats = summary?.threats ?? []
  const allSelected = threats.length > 0 && selected.size === threats.length
  const busy = scanning || starting
  const modeHint = MODES.find((item) => item.id === mode)?.hint ?? ''

  const chooseFolder = async (): Promise<string | null> => {
    try {
      const folder = await api.virus.chooseFolder()
      if (folder) {
        setCustomTarget(folder)
        return folder
      }
    } catch (error) {
      toast.push('error', errorMessage(error))
    }
    return null
  }

  const startScan = async (modeOverride?: ScanMode): Promise<void> => {
    if (busy) return
    const scanMode = modeOverride ?? mode
    let target = customTarget
    if (scanMode === 'custom' && !target) {
      const chosen = await chooseFolder()
      if (!chosen) return
      target = chosen
    }
    setMode(scanMode)
    setStarting(true)
    setSummary(null)
    setSelected(new Set())
    setSamplePath(null)
    setProgress({
      running: true,
      mode: scanMode,
      phase: 'preparing',
      percent: 1,
      filesScanned: 0,
      filesTotal: 0,
      currentPath: '正在准备查杀引擎…',
      threatsFound: 0,
      elapsedMs: 0,
      bytesScanned: 0
    })
    try {
      const result = await api.virus.scan({
        mode: scanMode,
        target: scanMode === 'custom' ? target : undefined
      })
      setSummary(result)
      if (result.cancelled) {
        toast.push('info', '查杀已停止')
      } else if (result.threats.length > 0) {
        toast.push('error', `发现 ${result.threats.length} 个风险项，建议立即隔离`)
      } else {
        toast.push('success', '查杀完成，未发现安全风险')
      }
    } catch (error) {
      toast.push('error', errorMessage(error))
    } finally {
      setStarting(false)
      setScanning(false)
      setProgress(null)
    }
  }

  const stopScan = async (): Promise<void> => {
    try {
      await api.virus.cancel()
      toast.push('info', '正在停止查杀…')
    } catch (error) {
      toast.push('error', errorMessage(error))
    }
  }

  const quarantine = async (ids: string[]): Promise<void> => {
    if (!summary || ids.length === 0 || quarantining) return
    setQuarantining(true)
    try {
      const result = await api.virus.quarantine(ids)
      const failedPaths = new Set(result.failed.map((entry) => entry.path))
      const removed = new Set(
        ids.filter((id) => {
          const threat = summary.threats.find((item) => item.id === id)
          return threat !== undefined && !failedPaths.has(threat.path)
        })
      )
      setSummary((previous) =>
        previous ? { ...previous, threats: previous.threats.filter((threat) => !removed.has(threat.id)) } : previous
      )
      setSelected(new Set())
      if (result.failed.length > 0) {
        toast.push('error', `已隔离 ${result.quarantined} 个，${result.failed.length} 个失败：${result.failed[0].error}`)
      } else {
        toast.push('success', `已将 ${result.quarantined} 个文件移入隔离区，可随时恢复`)
      }
    } catch (error) {
      toast.push('error', errorMessage(error))
    } finally {
      setQuarantining(false)
      setConfirmBulk(false)
    }
  }

  const createSample = async (): Promise<void> => {
    setCreatingSample(true)
    try {
      const result = await api.virus.createTestSample()
      if (!result.ok) {
        toast.push('error', result.message)
        return
      }
      setSamplePath(result.path ?? null)
      toast.push('success', '测试样本已生成，建议使用快速查杀验证')
      setConfirmSample(false)
    } catch (error) {
      toast.push('error', errorMessage(error))
    } finally {
      setCreatingSample(false)
    }
  }

  const toggleAll = (): void => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(threats.map((threat) => threat.id)))
  }

  const toggleOne = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const severityCounts = useMemo(() => {
    return {
      high: threats.filter((threat) => threat.severity === 'high').length,
      medium: threats.filter((threat) => threat.severity === 'medium').length,
      low: threats.filter((threat) => threat.severity === 'low').length
    }
  }, [threats])

  const currentPhaseText = progress
    ? progress.phase === 'preparing'
      ? '正在建立文件索引'
      : progress.phase === 'finalizing'
        ? '正在整理查杀结果'
        : progress.phase === 'scanning'
          ? '正在扫描文件'
          : progress.phase === 'cancelled'
            ? '查杀已停止'
            : '查杀完成'
    : ''

  return (
    <div className="page virus-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">木马查杀</h1>
          <p className="page-subtitle">本地特征引擎 + 启发式检测，查杀结果保存在本机，不上传文件</p>
        </div>
        <div className="page-actions">
          <Button variant="ghost" size="sm" icon={<ShieldCheck size={15} />} onClick={() => onNavigate('settings')}>
            隔离区
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>

      <Card className={cx('scan-card', scanning && 'scan-card-active')}>
        <div className="scan-modes-row">
          <div className="scan-modes">
            {MODES.map((item) => (
              <button
                type="button"
                key={item.id}
                className={cx('scan-mode', mode === item.id && 'scan-mode-active')}
                onClick={() => setMode(item.id)}
                disabled={busy}
              >
                <span className="scan-mode-icon">{item.icon}</span>
                <span className="scan-mode-text">
                  <b>{item.label}</b>
                  <small>{item.description}</small>
                </span>
              </button>
            ))}
          </div>
          <Button
            variant="primary"
            icon={<ScanLine size={17} />}
            onClick={() => startScan()}
            disabled={busy}
            loading={starting}
          >
            {scanning ? '查杀进行中' : '开始查杀'}
          </Button>
        </div>

        <div className="scan-hint">{modeHint}</div>

        {mode === 'custom' ? (
          <div className="custom-target">
            <FolderOpen size={16} />
            <span className="custom-target-path" title={customTarget || undefined}>
              {customTarget || '尚未选择要查杀的文件夹'}
            </span>
            <Button size="sm" variant="ghost" onClick={() => chooseFolder()} disabled={busy}>
              {customTarget ? '重新选择' : '选择文件夹'}
            </Button>
          </div>
        ) : null}

        <div className="scan-body">
          <div className="scan-visual">
            <div
              className={cx(
                'radar',
                scanning && 'radar-active',
                !scanning && threats.length > 0 && 'radar-alert'
              )}
            >
              <span className="radar-ring radar-ring-1" />
              <span className="radar-ring radar-ring-2" />
              <span className="radar-ring radar-ring-3" />
              <span className="radar-sweep" />
              <span className="radar-core">
                {scanning ? (
                  <Loader2 size={34} className="spin" />
                ) : threats.length > 0 ? (
                  <ShieldAlert size={36} />
                ) : (
                  <ShieldCheck size={36} />
                )}
              </span>
            </div>
            <span className="scan-visual-caption">
              {scanning ? '正在扫描…' : threats.length > 0 ? '发现风险' : summary ? '安全状态良好' : '引擎已就绪'}
            </span>
          </div>

          <div className="scan-info">
            {scanning ? (
              <div className="scan-running">
                <div className="scan-running-head">
                  <div>
                    <span className="scan-phase">
                      <span className="pulse-dot" />
                      {currentPhaseText}
                    </span>
                    <h2>{progress?.mode === 'full' ? '正在全盘查杀' : progress?.mode === 'custom' ? '正在查杀指定目录' : '正在快速查杀'}</h2>
                  </div>
                  <div className="scan-percent">
                    {Math.round(progress?.percent ?? 0)}
                    <span>%</span>
                  </div>
                </div>
                <ProgressBar value={progress?.percent ?? 0} striped />
                <div className="scan-path" title={progress?.currentPath || undefined}>
                  {progress?.currentPath ? shortPath(progress.currentPath, 34, 44) : '正在准备扫描引擎…'}
                </div>
                <div className="scan-live-stats">
                  <span>
                    已扫描 <b>{progress?.filesScanned ?? 0}</b>
                    {progress?.filesTotal ? ` / ${progress.filesTotal}` : ''} 个文件
                  </span>
                  <span className={cx(threats.length > 0 && 'is-danger')}>
                    发现风险 <b>{progress?.threatsFound ?? 0}</b> 个
                  </span>
                  <span>用时 <b>{formatDuration(progress?.elapsedMs ?? 0)}</b></span>
                  <Button size="sm" variant="secondary" icon={<Square size={13} />} onClick={stopScan}>
                    停止查杀
                  </Button>
                </div>
              </div>
            ) : summary ? (
              <div className="scan-result">
                <div
                  className={cx(
                    'result-banner',
                    summary.cancelled ? 'result-cancelled' : threats.length > 0 ? 'result-danger' : 'result-safe'
                  )}
                >
                  <span className="result-icon">
                    {summary.cancelled ? (
                      <AlertTriangle size={22} />
                    ) : threats.length > 0 ? (
                      <ShieldAlert size={22} />
                    ) : (
                      <CheckCircle2 size={22} />
                    )}
                  </span>
                  <div className="result-copy">
                    <h2>
                      {summary.cancelled
                        ? '查杀已停止'
                        : threats.length > 0
                          ? `发现 ${threats.length} 个风险项`
                          : '未发现安全风险'}
                    </h2>
                    <p>
                      {summary.cancelled
                        ? '本次扫描被提前中止，结果可能不完整，建议重新查杀。'
                        : threats.length > 0
                          ? '建议将检测到的文件移入隔离区，隔离后可以随时恢复。'
                          : '本次扫描已完成，您的电脑目前没有发现安全风险。'}
                    </p>
                  </div>
                  {threats.length > 0 ? (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<ShieldAlert size={15} />}
                      onClick={() => {
                        setSelected(new Set(threats.map((threat) => threat.id)))
                        setConfirmBulk(true)
                      }}
                    >
                      一键隔离
                    </Button>
                  ) : null}
                </div>
                <div className="scan-stats">
                  <div className="scan-stat">
                    <span>扫描文件</span>
                    <b>{summary.scannedFiles}</b>
                  </div>
                  <div className="scan-stat">
                    <span>用时</span>
                    <b>{formatDuration(summary.finishedAt - summary.startedAt)}</b>
                  </div>
                  <div className="scan-stat">
                    <span>风险项</span>
                    <b className={cx(threats.length > 0 && 'danger-text')}>{threats.length}</b>
                  </div>
                  <div className="scan-stat">
                    <span>跳过文件</span>
                    <b>{summary.skippedFiles}</b>
                  </div>
                </div>
                <div className="scan-result-foot">
                  <span className="scan-result-meta">
                    {summary.mode === 'full' ? '全盘查杀' : summary.mode === 'custom' ? '自定义查杀' : '快速查杀'} ·{' '}
                    {formatDate(summary.finishedAt)} · {shortPath(summary.target, 26, 32)}
                  </span>
                  <div className="scan-result-actions">
                    <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => startScan()}>
                      再次查杀
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onNavigate('settings')}>
                      查看隔离区
                      <ChevronRight size={14} />
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="scan-idle">
                <span className="scan-idle-kicker">
                  <ShieldCheck size={15} />
                  本地查杀引擎 · 已就绪
                </span>
                <h2>{stateLoaded ? '保护电脑，从一次查杀开始' : '正在读取查杀状态…'}</h2>
                <p>
                  快速查杀会扫描桌面、下载与启动项等常用位置。发现风险后，文件将优先移入隔离区，不会直接删除。
                </p>
                <div className="scan-idle-points">
                  <span><CheckCircle2 size={14} /> 特征匹配 + 启发式检测</span>
                  <span><CheckCircle2 size={14} /> 隔离可恢复</span>
                  <span><CheckCircle2 size={14} /> 文件不出本机</span>
                </div>
                <Button variant="primary" icon={<ScanLine size={17} />} onClick={() => startScan()} disabled={busy} loading={starting}>
                  立即查杀
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      {threats.length > 0 ? (
        <Card className="threat-card">
          <div className="card-head threat-card-head">
            <div>
              <h3>
                风险项
                <Chip tone="red">{threats.length}</Chip>
              </h3>
              <p>
                高风险 {severityCounts.high} · 中风险 {severityCounts.medium} · 低风险 {severityCounts.low}
              </p>
            </div>
            <div className="threat-toolbar">
              <label className="select-all">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                全选
              </label>
              <Button
                variant="primary"
                size="sm"
                icon={<ShieldAlert size={15} />}
                disabled={selected.size === 0 || quarantining}
                loading={quarantining}
                onClick={() => setConfirmBulk(true)}
              >
                隔离所选（{selected.size}）
              </Button>
            </div>
          </div>

          <div className="threat-table">
            <div className="threat-table-head">
              <span />
              <span>风险名称</span>
              <span>文件位置</span>
              <span>大小</span>
              <span>操作</span>
            </div>
            {threats.map((threat) => {
              const category = CATEGORY_META[threat.category]
              const severity = SEVERITY_META[threat.severity]
              return (
                <div className="threat-row" key={threat.id}>
                  <label className="row-checkbox">
                    <input
                      type="checkbox"
                      checked={selected.has(threat.id)}
                      onChange={() => toggleOne(threat.id)}
                      aria-label={`选择 ${threat.name}`}
                    />
                  </label>
                  <div className="threat-name-cell">
                    <div className="threat-name-line">
                      <b>{threat.name}</b>
                      <Chip tone={severity.tone}>{severity.label}</Chip>
                      <Chip tone={category.tone}>{category.label}</Chip>
                    </div>
                    <span className="threat-desc" title={threat.description}>
                      {threat.description}
                    </span>
                  </div>
                  <span className="threat-path" title={threat.path}>
                    {shortPath(threat.path, 24, 30)}
                  </span>
                  <span className="threat-size">{formatBytes(threat.size)}</span>
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => quarantine([threat.id])}
                    disabled={quarantining}
                  >
                    隔离
                  </Button>
                </div>
              )
            })}
          </div>
        </Card>
      ) : null}

      <div className="scan-tip-strip">
        <span className="tip-strip-icon">
          <FlaskConical size={20} />
        </span>
        <div className="tip-strip-copy">
          <b>想验证查杀效果？</b>
          <span>
            生成一个无害的测试样本，使用快速查杀即可检出。样本仅为纯文本，不包含任何可执行代码。
          </span>
          {samplePath ? (
            <span className="sample-created" title={samplePath}>
              <CheckCircle2 size={13} />
              已生成：{shortPath(samplePath, 20, 26)}
              <button type="button" onClick={() => startScan('quick')}>
                立即查杀
              </button>
            </span>
          ) : null}
        </div>
        <Button variant="secondary" size="sm" icon={<FlaskConical size={14} />} onClick={() => setConfirmSample(true)}>
          生成测试样本
        </Button>
      </div>

      <ConfirmDialog
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={() => quarantine([...selected])}
        title={`隔离选中的 ${selected.size} 个风险项？`}
        confirmText="移入隔离区"
        tone="amber"
        busy={quarantining}
      >
        <p>文件会被移动到本机隔离区，不会直接删除，您可以随时在「设置中心 → 隔离区」中恢复。</p>
        {selected.size > 0 ? (
          <p className="modal-note">
            共 {selected.size} 个文件，其中高风险 {threats.filter((t) => selected.has(t.id) && t.severity === 'high').length} 个。
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmSample}
        onClose={() => setConfirmSample(false)}
        onConfirm={createSample}
        title="生成无害测试样本？"
        confirmText="生成样本"
        busy={creatingSample}
        icon={<FlaskConical size={22} />}
      >
        <p>将在「下载」文件夹写入一个纯文本文件，用于验证查杀与隔离流程，不会执行任何代码。</p>
        <p className="modal-note">验证完成后可直接删除该文件。</p>
      </ConfirmDialog>
    </div>
  )
}
