import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  Cpu,
  Database,
  FolderOpen,
  History,
  Info,
  Loader2,
  Lock,
  Monitor,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2
} from 'lucide-react'
import type { ActionResult, AppInfo, PageId, QuarantineItem, ScanHistoryItem } from '@shared/types'
import { AiConfigCard } from '../components/AiConfigCard'
import { Logo } from '../components/Logo'
import { Button, Card, Chip, ConfirmDialog, EmptyState } from '../components/ui'
import { useToast } from '../components/Toast'
import {
  cx,
  errorMessage,
  formatBytes,
  formatDateTime,
  formatDuration,
  scanModeLabel,
  shortPath,
  timeAgo
} from '../lib/format'

type PendingAction = { kind: 'restore' | 'delete'; ids: string[] }

function platformLabel(platform?: string): string {
  if (!platform) return '读取中'
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return platform
}

export function SettingsPage({ onNavigate }: { onNavigate?: (page: PageId) => void }): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [quarantine, setQuarantine] = useState<QuarantineItem[]>([])
  const [history, setHistory] = useState<ScanHistoryItem[]>([])
  const [quarantineLoading, setQuarantineLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => {
    let alive = true
    Promise.allSettled([api.app.info(), api.virus.quarantineList(), api.virus.history()]).then(
      ([infoResult, quarantineResult, historyResult]) => {
        if (!alive) return
        if (infoResult.status === 'fulfilled') setInfo(infoResult.value)
        if (quarantineResult.status === 'fulfilled') setQuarantine(quarantineResult.value)
        if (historyResult.status === 'fulfilled') setHistory(historyResult.value)
        const failure = [infoResult, quarantineResult, historyResult].find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') {
          toast.push('error', errorMessage(failure.reason))
        }
        setQuarantineLoading(false)
        setHistoryLoading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [api, toast])

  const refreshQuarantine = async (): Promise<void> => {
    setQuarantineLoading(true)
    try {
      setQuarantine(await api.virus.quarantineList())
    } catch (refreshError) {
      toast.push('error', errorMessage(refreshError))
    } finally {
      setSelected(new Set())
      setQuarantineLoading(false)
    }
  }

  const refreshHistory = async (): Promise<void> => {
    setHistoryLoading(true)
    try {
      setHistory(await api.virus.history())
    } catch (refreshError) {
      toast.push('error', errorMessage(refreshError))
    } finally {
      setHistoryLoading(false)
    }
  }

  const openDataDir = async (): Promise<void> => {
    try {
      await api.app.openDataDir()
    } catch (openError) {
      toast.push('error', errorMessage(openError))
    }
  }

  const toggleOne = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = quarantine.length > 0 && selected.size === quarantine.length

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(quarantine.map((item) => item.id)))
  }

  const runAction = async (): Promise<void> => {
    if (!pending || actionBusy) return
    setActionBusy(true)
    try {
      const result: ActionResult =
        pending.kind === 'restore'
          ? await api.virus.restore(pending.ids)
          : await api.virus.deleteQuarantine(pending.ids)
      toast.push(result.ok ? 'success' : 'error', result.message)
      setPending(null)
    } catch (actionError) {
      toast.push('error', errorMessage(actionError))
    } finally {
      setActionBusy(false)
      await refreshQuarantine()
    }
  }

  return (
    <div className="page settings-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">设置中心</h1>
          <p className="page-subtitle">管理 AI 模型接入、隔离文件与查杀记录，配置与本地记录仅保存在本机</p>
        </div>
        <div className="page-actions">
          {onNavigate ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Sparkles size={15} />}
              onClick={() => onNavigate('assistant')}
            >
              打开 AI 助手
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" icon={<FolderOpen size={15} />} onClick={openDataDir}>
            打开数据目录
          </Button>
        </div>
      </div>

      <AiConfigCard onNavigate={onNavigate} />

      <div className="settings-grid">
        <Card className="settings-card quarantine-card">
          <div className="card-head">
            <div>
              <h3>
                隔离区
                <Chip tone={quarantine.length > 0 ? 'amber' : 'green'}>{quarantine.length}</Chip>
              </h3>
              <p>被隔离的文件不会被执行，可随时恢复到原始位置</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={quarantineLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              onClick={refreshQuarantine}
              disabled={quarantineLoading}
            >
              刷新
            </Button>
          </div>

          {quarantineLoading ? (
            <div className="quarantine-loading">
              <Loader2 size={20} className="spin" />
              正在读取隔离区…
            </div>
          ) : quarantine.length > 0 ? (
            <>
              <div className="quarantine-actions">
                <label className="select-all">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  全选
                </label>
                <span className="quarantine-selected">已选 {selected.size} 项</span>
                <div className="quarantine-action-buttons">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<RotateCcw size={14} />}
                    disabled={selected.size === 0 || actionBusy}
                    onClick={() => setPending({ kind: 'restore', ids: [...selected] })}
                  >
                    恢复所选
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    className="quarantine-delete-btn"
                    disabled={selected.size === 0 || actionBusy}
                    onClick={() => setPending({ kind: 'delete', ids: [...selected] })}
                  >
                    永久删除
                  </Button>
                </div>
              </div>

              <div className="quarantine-list">
                {quarantine.map((item) => (
                  <div className="quarantine-row" key={item.id}>
                    <label className="row-checkbox">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggleOne(item.id)}
                        aria-label={`选择 ${item.threatName}`}
                      />
                    </label>
                    <span className="quarantine-icon">
                      <ShieldOff size={17} />
                    </span>
                    <div className="quarantine-copy">
                      <b title={item.threatName}>{item.threatName}</b>
                      <span title={item.originalPath}>{shortPath(item.originalPath, 24, 30)}</span>
                    </div>
                    <div className="quarantine-meta">
                      <b>{formatBytes(item.size)}</b>
                      <span>{formatDateTime(item.quarantinedAt)}</span>
                    </div>
                    <div className="quarantine-row-actions">
                      <Button
                        variant="subtle"
                        size="sm"
                        onClick={() => setPending({ kind: 'restore', ids: [item.id] })}
                        disabled={actionBusy}
                      >
                        恢复
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="quarantine-delete-btn"
                        onClick={() => setPending({ kind: 'delete', ids: [item.id] })}
                        disabled={actionBusy}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              icon={<ShieldCheck size={26} />}
              title="隔离区为空"
              description="查杀发现风险后，可将文件移入隔离区，这里会显示隔离记录"
            />
          )}

          <div className="quarantine-note">
            <Info size={14} />
            恢复时若原始位置已有同名文件，将自动添加后缀，不会覆盖现有文件。
          </div>
        </Card>

        <div className="settings-side">
          <Card className="settings-card app-info-card">
            <div className="card-head">
              <div>
                <h3>应用信息</h3>
                <p>本地安全引擎运行详情</p>
              </div>
              <span className="app-version">v{info?.version ?? '1.0.0'}</span>
            </div>

            <div className="app-brand">
              <Logo size={48} />
              <div>
                <b>若道安全卫士</b>
                <span>Ruodao Guard · {info?.packaged ? '安装版' : '开发版'}</span>
              </div>
            </div>

            <div className="app-info-list">
              <div>
                <span>
                  <Monitor size={14} />
                  运行平台
                </span>
                <b>{info ? `${platformLabel(info.platform)} · ${info.arch}` : '读取中…'}</b>
              </div>
              <div>
                <span>
                  <Cpu size={14} />
                  运行时
                </span>
                <b>{info ? `Electron ${info.electron} · Chromium ${info.chrome}` : '读取中…'}</b>
              </div>
              <div>
                <span>
                  <Database size={14} />
                  Node.js
                </span>
                <b>{info?.node ?? '读取中…'}</b>
              </div>
            </div>

            <div className="data-dir-block">
              <span>本地数据目录</span>
              <code title={info?.dataDir}>{info?.dataDir ?? '正在读取…'}</code>
              <Button variant="secondary" size="sm" icon={<FolderOpen size={13} />} onClick={openDataDir}>
                打开
              </Button>
            </div>
          </Card>

          <Card className="settings-card safety-card">
            <div className="card-head">
              <div>
                <h3>安全与隐私</h3>
                <p>默认安全的设计原则</p>
              </div>
            </div>
            <div className="safety-list">
              <div className="safety-item">
                <span>
                  <ShieldCheck size={16} />
                </span>
                <div>
                  <b>扫描不上传</b>
                  <p>特征匹配与文件分析全部在本机完成，不会上传任何文件。</p>
                </div>
              </div>
              <div className="safety-item">
                <span>
                  <RotateCcw size={16} />
                </span>
                <div>
                  <b>隔离可恢复</b>
                  <p>隔离仅移动文件，只有手动永久删除才会从磁盘移除。</p>
                </div>
              </div>
              <div className="safety-item">
                <span>
                  <Lock size={16} />
                </span>
                <div>
                  <b>敏感操作二次确认</b>
                  <p>清理、卸载与删除隔离文件前都会明确提示影响范围。</p>
                </div>
              </div>
            </div>
            <div className="safety-foot">
              <ShieldCheck size={13} />
              本地引擎 · 无广告 · 无捆绑
            </div>
          </Card>
        </div>
      </div>

      <Card className="settings-card history-card">
        <div className="card-head">
          <div>
            <h3>
              查杀记录
              <Chip tone="gray">{history.length}</Chip>
            </h3>
            <p>本机最近 20 次查杀结果，用于体检评分与风险追踪</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={historyLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            onClick={refreshHistory}
            disabled={historyLoading}
          >
            刷新
          </Button>
        </div>

        {historyLoading ? (
          <div className="quarantine-loading">
            <Loader2 size={20} className="spin" />
            正在读取查杀记录…
          </div>
        ) : history.length > 0 ? (
          <div className="history-list">
            {history.map((record) => (
              <div className="history-row" key={record.id}>
                <span className={cx('history-icon', record.threats > 0 && 'is-danger')}>
                  {record.threats > 0 ? <ShieldOff size={16} /> : <CheckCircle2 size={16} />}
                </span>
                <div className="history-copy">
                  <div className="history-title">
                    <Chip tone={record.mode === 'full' ? 'violet' : record.mode === 'custom' ? 'blue' : 'green'}>
                      {scanModeLabel(record.mode)}
                    </Chip>
                    <span>{formatDateTime(record.completedAt)}</span>
                    {record.cancelled ? <Chip tone="gray">已停止</Chip> : null}
                  </div>
                  <span className="history-target" title={record.target}>
                    {shortPath(record.target, 36, 40)}
                  </span>
                </div>
                <div className="history-stats">
                  <span className={cx(record.threats > 0 && 'is-danger')}>
                    <b>{record.threats}</b> 风险
                  </span>
                  <span>
                    <b>{record.scannedFiles}</b> 文件
                  </span>
                  <span>{formatDuration(record.durationMs)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<History size={26} />}
            title="还没有查杀记录"
            description="完成一次木马查杀后，扫描摘要会保存在这里"
          />
        )}
        {history.length > 0 ? <div className="history-foot">最近一次查杀：{timeAgo(history[0].completedAt)}</div> : null}
      </Card>

      <ConfirmDialog
        open={pending?.kind === 'restore'}
        onClose={() => {
          if (!actionBusy) setPending(null)
        }}
        onConfirm={runAction}
        title={`恢复 ${pending?.ids.length ?? 0} 个隔离文件？`}
        confirmText="恢复文件"
        busy={actionBusy}
        icon={<RotateCcw size={22} />}
      >
        <p>文件将放回原始路径。若原位置已存在同名文件，会自动添加后缀，不会覆盖现有文件。</p>
        <p className="modal-note">恢复后文件将重新出现在磁盘上，请确认来源可信后再运行。</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onClose={() => {
          if (!actionBusy) setPending(null)
        }}
        onConfirm={runAction}
        title={`永久删除 ${pending?.ids.length ?? 0} 个隔离文件？`}
        confirmText="永久删除"
        tone="danger"
        busy={actionBusy}
        icon={<Trash2 size={22} />}
      >
        <p>文件将从隔离区彻底移除，此操作无法撤销，也无法通过本工具恢复。</p>
        <p className="modal-note">如果只是暂不确定文件是否安全，建议先保留在隔离区。</p>
      </ConfirmDialog>
    </div>
  )
}
