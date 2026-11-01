import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  FileWarning,
  Globe,
  Image,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import type { CleanResult, JunkCategory, JunkCategoryId, JunkReport } from '@shared/types'
import { Button, Card, ConfirmDialog, EmptyState, ProgressBar, Skeleton } from '../components/ui'
import { useToast } from '../components/Toast'
import { cx, errorMessage, formatBytes, shortPath, timeAgo } from '../lib/format'

const CATEGORY_ICONS: Record<JunkCategoryId, React.ReactNode> = {
  'user-temp': <FileText size={19} />,
  'system-temp': <Wrench size={19} />,
  'browser-cache': <Globe size={19} />,
  thumbnails: <Image size={19} />,
  'crash-dumps': <FileWarning size={19} />
}

const CATEGORY_TONES: Record<JunkCategoryId, string> = {
  'user-temp': 'blue',
  'system-temp': 'violet',
  'browser-cache': 'green',
  thumbnails: 'amber',
  'crash-dumps': 'red'
}

export function JunkPage({
  onNavigate
}: {
  onNavigate: (page: 'home' | 'virus' | 'junk' | 'software' | 'drivers' | 'startup' | 'settings') => void
}): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [report, setReport] = useState<JunkReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<Set<JunkCategoryId>>(new Set())
  const [expanded, setExpanded] = useState<Set<JunkCategoryId>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [lastResult, setLastResult] = useState<CleanResult | null>(null)

  useEffect(() => {
    let alive = true
    api.junk
      .last()
      .then((cached) => {
        if (!alive) return
        if (cached) {
          setReport(cached)
          setSelected(defaultSelection(cached))
        } else {
          void runScan()
        }
      })
      .catch(() => {
        if (alive) void runScan()
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectable = useMemo(
    () => (report?.categories ?? []).filter((category) => category.available && category.bytes > 0),
    [report]
  )
  const allSelected = selectable.length > 0 && selectable.every((category) => selected.has(category.id))
  const selectedCategories = (report?.categories ?? []).filter((category) => selected.has(category.id))
  const selectedBytes = selectedCategories.reduce((sum, category) => sum + category.bytes, 0)

  async function runScan(): Promise<void> {
    setScanning(true)
    setLastResult(null)
    try {
      const result = await api.junk.scan()
      setReport(result)
      setSelected(defaultSelection(result))
      setExpanded(new Set())
    } catch (error) {
      toast.push('error', errorMessage(error))
    } finally {
      setScanning(false)
    }
  }

  function defaultSelection(nextReport: JunkReport): Set<JunkCategoryId> {
    return new Set(
      nextReport.categories.filter((category) => category.available && category.bytes > 0).map((category) => category.id)
    )
  }

  const toggleCategory = (category: JunkCategory): void => {
    if (!category.available || category.bytes === 0) return
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(category.id)) next.delete(category.id)
      else next.add(category.id)
      return next
    })
  }

  const toggleAll = (): void => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(selectable.map((category) => category.id)))
  }

  const toggleExpanded = (id: JunkCategoryId): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clean = async (): Promise<void> => {
    if (selected.size === 0) return
    setCleaning(true)
    try {
      const result = await api.junk.clean([...selected])
      setReport(result.report)
      setSelected(defaultSelection(result.report))
      setLastResult(result)
      setConfirmOpen(false)
      if (result.freedBytes > 0) {
        toast.push('success', `清理完成，释放 ${formatBytes(result.freedBytes)} 空间`)
      } else {
        toast.push('info', '没有可清理的文件，部分文件可能正在被占用')
      }
    } catch (error) {
      toast.push('error', errorMessage(error))
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="page junk-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">垃圾清理</h1>
          <p className="page-subtitle">清理临时文件、浏览器缓存与系统残留，释放磁盘空间且不触碰个人文件</p>
        </div>
        <div className="page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={scanning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            onClick={runScan}
            disabled={scanning || cleaning}
          >
            {scanning ? '扫描中…' : '重新扫描'}
          </Button>
        </div>
      </div>

      <Card className="junk-summary">
        <div className="junk-summary-left">
          <span className="junk-kicker">
            <Trash2 size={15} />
            {scanning ? '正在扫描垃圾文件' : report ? `扫描于 ${timeAgo(report.scannedAt)}` : '等待扫描'}
          </span>
          {scanning ? (
            <>
              <Skeleton className="junk-total-skeleton" />
              <Skeleton className="junk-sub-skeleton" />
            </>
          ) : (
            <>
              <div className="junk-total">
                {report ? formatBytes(report.totalBytes) : '—'}
                <span>可释放</span>
              </div>
              <p className="junk-sub">
                {report
                  ? `${report.totalFiles.toLocaleString('zh-CN')} 个文件 · 已选择 ${selectedCategories.length} 项`
                  : '点击右下角按钮开始扫描'}
              </p>
            </>
          )}
        </div>

        <div className="junk-summary-right">
          <div className="junk-selection">
            <span>已选 <b>{formatBytes(selectedBytes)}</b></span>
            <span className="junk-selection-note">
              {allSelected ? '已选择全部可清理项' : `共 ${selectable.length} 项可清理`}
            </span>
          </div>
          <div className="junk-summary-actions">
            <Button variant="ghost" size="sm" onClick={toggleAll} disabled={scanning || selectable.length === 0}>
              {allSelected ? '取消全选' : '全选'}
            </Button>
            <Button
              variant="primary"
              icon={<Sparkles size={16} />}
              disabled={scanning || cleaning || selectedBytes === 0}
              onClick={() => setConfirmOpen(true)}
            >
              一键清理
            </Button>
          </div>
          {scanning ? <ProgressBar value={0} striped indeterminate /> : null}
        </div>
      </Card>

      {lastResult ? (
        <div className={cx('clean-result', lastResult.freedBytes > 0 ? 'clean-result-success' : 'clean-result-neutral')}>
          <span className="clean-result-icon">
            <CheckCircle2 size={20} />
          </span>
          <div className="clean-result-copy">
            <b>
              清理完成，释放 {formatBytes(lastResult.freedBytes)} 空间
            </b>
            <span>
              共删除 {lastResult.deletedFiles} 个文件
              {lastResult.skippedFiles > 0 ? `，${lastResult.skippedFiles} 个文件正在使用已跳过` : ''}
              {lastResult.report.totalBytes > 0 ? `，仍有 ${formatBytes(lastResult.report.totalBytes)} 可清理` : '，系统已经很干净'}
            </span>
            {lastResult.errors.length > 0 ? (
              <span className="clean-errors" title={lastResult.errors.join('\n')}>
                部分文件无法删除：{lastResult.errors[0]}
              </span>
            ) : null}
          </div>
          <button type="button" className="clean-result-close" onClick={() => setLastResult(null)} aria-label="关闭清理结果">
            <X size={16} />
          </button>
        </div>
      ) : null}

      <Card className="junk-list-card">
        <div className="card-head">
          <div>
            <h3>清理项目</h3>
            <p>清理前可展开查看占用较大的文件</p>
          </div>
          <label className="select-all">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={scanning || selectable.length === 0} />
            全选
          </label>
        </div>

        {scanning ? (
          <div className="junk-scanning">
            <div className="junk-scanning-head">
              <span className="junk-scanning-icon">
                <Loader2 size={22} className="spin" />
              </span>
              <div>
                <b>正在扫描系统垃圾</b>
                <p>检查临时目录、浏览器缓存与系统残留，请稍候…</p>
              </div>
            </div>
            {[0, 1, 2, 3].map((item) => (
              <div className="junk-row-skeleton" key={item}>
                <Skeleton className="skeleton-check" />
                <Skeleton className="skeleton-icon" />
                <div className="skeleton-copy">
                  <Skeleton className="skeleton-line" />
                  <Skeleton className="skeleton-line short" />
                </div>
                <Skeleton className="skeleton-value" />
              </div>
            ))}
          </div>
        ) : report && report.categories.length > 0 ? (
          <div className="junk-categories">
            {report.categories.map((category) => {
              const isSelected = selected.has(category.id)
              const isExpanded = expanded.has(category.id)
              const disabled = !category.available || category.bytes === 0
              return (
                <div className={cx('junk-category', isExpanded && 'junk-category-expanded')} key={category.id}>
                  <div className="junk-row">
                    <label className={cx('row-checkbox', disabled && 'row-checkbox-disabled')}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={disabled}
                        onChange={() => toggleCategory(category)}
                        aria-label={`选择清理 ${category.name}`}
                      />
                    </label>
                    <span className={cx('junk-icon', `junk-icon-${CATEGORY_TONES[category.id]}`)}>
                      {CATEGORY_ICONS[category.id]}
                    </span>
                    <div className="junk-copy">
                      <div className="junk-title-line">
                        <b>{category.name}</b>
                        {!category.available ? <span className="junk-missing">未检测到</span> : null}
                      </div>
                      <p>{category.description}</p>
                      {category.note ? <span className="junk-note">{category.note}</span> : null}
                    </div>
                    <div className="junk-value">
                      <b>{category.bytes > 0 ? formatBytes(category.bytes) : '0 B'}</b>
                      <span>{category.files > 0 ? `${category.files} 个文件` : '无需清理'}</span>
                    </div>
                    <button
                      type="button"
                      className={cx('junk-expand', isExpanded && 'junk-expand-open')}
                      onClick={() => toggleExpanded(category.id)}
                      aria-label={isExpanded ? '收起文件列表' : '展开文件列表'}
                      disabled={category.items.length === 0}
                    >
                      {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                  </div>
                  {isExpanded && category.items.length > 0 ? (
                    <div className="junk-items">
                      {category.items.map((item) => (
                        <div className="junk-item" key={item.path}>
                          <span className="junk-item-path" title={item.path}>
                            {shortPath(item.path, 44, 36)}
                          </span>
                          <span className="junk-item-size">{formatBytes(item.bytes)}</span>
                        </div>
                      ))}
                      <span className="junk-items-note">仅展示占用较大的文件</span>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={<Trash2 size={26} />}
            title="还没有扫描结果"
            description="扫描后会在这里列出可清理的垃圾文件分类"
            action={
              <Button variant="primary" size="sm" onClick={runScan} loading={scanning}>
                开始扫描
              </Button>
            }
          />
        )}

        <div className="junk-safe-note">
          <ShieldCheck size={15} />
          仅清理系统临时目录与各类缓存，不会删除个人文档、照片、下载文件或聊天记录。
        </div>
      </Card>

      <div className="page-foot-link">
        <button type="button" onClick={() => onNavigate('startup')}>
          电脑开机太慢？检查开机启动项
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={clean}
        title={`清理选中的 ${selectedCategories.length} 个分类？`}
        confirmText="开始清理"
        tone="amber"
        busy={cleaning}
        icon={<Trash2 size={22} />}
      >
        <p>
          将清理约 <b>{formatBytes(selectedBytes)}</b> 的临时文件与缓存。正在被程序使用的文件会自动跳过，
          不会删除个人文件。
        </p>
        <div className="confirm-list">
          {selectedCategories.map((category) => (
            <div className="confirm-list-item" key={category.id}>
              <span>{category.name}</span>
              <b>{formatBytes(category.bytes)}</b>
            </div>
          ))}
        </div>
        <p className="modal-note">临时文件清理后无法恢复，浏览器缓存在下次访问网页时会自动重新生成。</p>
      </ConfirmDialog>
    </div>
  )
}
