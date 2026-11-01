import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  FolderOpen,
  Info,
  Loader2,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import type { DiskInfo, PageId, SoftwareItem, SoftwareReport } from '@shared/types'
import { Button, Card, ConfirmDialog, EmptyState, Skeleton } from '../components/ui'
import { useToast } from '../components/Toast'
import { cx, errorMessage, formatBytes, timeAgo } from '../lib/format'

type SortKey = 'name' | 'size' | 'date'
type SoftwareTab = 'all' | 'recent' | 'user' | 'system'

const RECENT_DAYS = 30
const AVATAR_TONES = ['green', 'blue', 'amber', 'violet', 'teal', 'rose'] as const

const TABS: ReadonlyArray<{ id: SoftwareTab; label: string }> = [
  { id: 'all', label: '全部软件' },
  { id: 'recent', label: '最近安装' },
  { id: 'user', label: '当前用户' },
  { id: 'system', label: '系统安装' }
]

function initialsOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const cjkIndex = trimmed.search(/[\u4e00-\u9fa5]/)
  if (cjkIndex > 0 && /^[\d\s._-]+$/.test(trimmed.slice(0, cjkIndex))) {
    return trimmed.slice(cjkIndex, cjkIndex + 2)
  }
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(0, 2)
  const words = trimmed
    .replace(/^[\d\s._-]+/, '')
    .split(/\s+/)
    .filter((word) => word && !/^[\d.]+$/.test(word))
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return (words[0] ?? trimmed).slice(0, 2).toUpperCase()
}

function toneOf(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length]
}

function sourceLabel(source: SoftwareItem['source']): string {
  if (source === 'user') return '当前用户'
  if (source === 'machine32') return '系统 · 32 位'
  return '系统安装'
}

function metaLine(item: SoftwareItem): string {
  const parts: string[] = []
  if (item.publisher) parts.push(item.publisher)
  if (item.version) parts.push(`v${item.version}`)
  return parts.join(' · ') || '版本信息未登记'
}

function isRecentInstall(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const installedAt = new Date(`${date}T00:00:00`).getTime()
  if (!Number.isFinite(installedAt)) return false
  return installedAt >= Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000
}

function SortMark({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }): React.JSX.Element {
  if (!active) return <ArrowUpDown size={12} />
  return direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
}

export function SoftwarePage({ onNavigate }: { onNavigate?: (page: PageId) => void }): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [report, setReport] = useState<SoftwareReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<SoftwareTab>('all')
  const [sort, setSort] = useState<SortKey>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [pendingUninstall, setPendingUninstall] = useState<SoftwareItem | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [systemDisk, setSystemDisk] = useState<DiskInfo | null>(null)

  useEffect(() => {
    let alive = true
    api.software
      .list()
      .then((data) => {
        if (alive) setReport(data)
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

  useEffect(() => {
    let alive = true
    api.system
      .snapshot()
      .then((snapshot) => {
        if (!alive) return
        const disk = snapshot.disks.find((item) => item.id.toUpperCase().startsWith('C:')) ?? snapshot.disks[0]
        if (disk && disk.free > 0) setSystemDisk(disk)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api])

  const items = report?.items ?? []
  const recentCount = useMemo(() => items.filter((item) => isRecentInstall(item.installDate)).length, [items])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const matched = items.filter((item) => {
      if (tab === 'recent' && !isRecentInstall(item.installDate)) return false
      if (tab === 'user' && item.source !== 'user') return false
      if (tab === 'system' && item.source === 'user') return false
      if (!keyword) return true
      return (
        item.name.toLowerCase().includes(keyword) ||
        item.publisher.toLowerCase().includes(keyword) ||
        item.installLocation.toLowerCase().includes(keyword)
      )
    })
    const factor = direction === 'asc' ? 1 : -1
    return [...matched].sort((a, b) => {
      if (sort === 'size') return (a.estimatedBytes - b.estimatedBytes) * factor
      if (sort === 'date') {
        const left = a.installDate || ''
        const right = b.installDate || ''
        if (!left && !right) return a.name.localeCompare(b.name, 'zh-CN')
        if (!left) return 1
        if (!right) return -1
        return left.localeCompare(right) * factor
      }
      return a.name.localeCompare(b.name, 'zh-CN') * factor
    })
  }, [items, query, tab, sort, direction])

  const changeSort = (key: SortKey): void => {
    if (sort === key) {
      setDirection((previous) => (previous === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSort(key)
    setDirection(key === 'name' ? 'asc' : 'desc')
  }

  const selectTab = (next: SoftwareTab): void => {
    setTab(next)
    if (next === 'recent') {
      setSort('date')
      setDirection('desc')
    }
  }

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setError(null)
    try {
      const data = await api.software.list(true)
      setReport(data)
      toast.push('success', `已刷新软件列表，共 ${data.items.length} 款软件`)
    } catch (refreshError) {
      const message = errorMessage(refreshError)
      setError(message)
      toast.push('error', message)
    } finally {
      setRefreshing(false)
    }
  }

  const openLocation = async (item: SoftwareItem): Promise<void> => {
    if (openingId) return
    setOpeningId(item.id)
    try {
      const result = await api.software.openLocation(item.id)
      toast.push(result.ok ? 'success' : 'error', result.message)
    } catch (openError) {
      toast.push('error', errorMessage(openError))
    } finally {
      setOpeningId(null)
    }
  }

  const uninstall = async (): Promise<void> => {
    if (!pendingUninstall || uninstalling) return
    setUninstalling(true)
    try {
      const result = await api.software.uninstall(pendingUninstall.id)
      toast.push(result.ok ? 'success' : 'error', result.message)
      setPendingUninstall(null)
    } catch (uninstallError) {
      toast.push('error', errorMessage(uninstallError))
    } finally {
      setUninstalling(false)
    }
  }

  const resetFilters = (): void => {
    setQuery('')
    setTab('all')
  }

  const tabMeta = loading
    ? '读取中…'
    : query.trim()
      ? `找到 ${filtered.length} 款`
      : tab === 'recent'
        ? `近 30 天 ${filtered.length} 款`
        : `共 ${filtered.length} 款`

  return (
    <div className="page software-page">
      <div className="page-header software-page-header">
        <div>
          <h1 className="page-title">软件管家</h1>
          <p className="page-subtitle">管理已安装软件，卸载不需要的程序，释放磁盘空间</p>
        </div>
      </div>

      <Card className="software-shell">
        <div className="software-overview">
          <label className="software-search">
            <Search size={18} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="请输入您要卸载的软件"
              spellCheck={false}
              aria-label="搜索软件名称、发布者或安装位置"
            />
            {query ? (
              <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清除搜索">
                <X size={15} />
              </button>
            ) : null}
          </label>

          <div className="software-summary">
            <p className="software-summary-text">
              {loading ? (
                '正在读取已安装软件…'
              ) : (
                <>
                  最近安装软件 <b>{recentCount}</b> 款
                  {systemDisk ? (
                    <>
                      ，系统盘（{systemDisk.id}）可用空间 <b>{formatBytes(systemDisk.free)}</b>
                    </>
                  ) : null}
                  {onNavigate ? (
                    <button
                      type="button"
                      className="software-disk-link"
                      onClick={() => onNavigate('junk')}
                      title="前往垃圾清理，释放系统盘空间"
                    >
                      系统盘清理
                      <Info size={13} />
                    </button>
                  ) : null}
                </>
              )}
            </p>
            <div className="software-summary-actions">
              <button
                type="button"
                className="software-refresh"
                onClick={refresh}
                disabled={refreshing || loading}
                title="重新读取已安装软件"
              >
                {refreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                {refreshing ? '刷新中' : '刷新'}
              </button>
            </div>
          </div>
        </div>

        <div className="software-tabbar">
          <div className="software-tabs" role="tablist" aria-label="软件筛选">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={cx('software-tab', tab === item.id && 'software-tab-active')}
                onClick={() => selectTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="software-tab-meta">{tabMeta}</span>
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
          <div className="software-table" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="software-skeleton-row" key={index}>
                <div className="software-name-cell">
                  <Skeleton className="software-skeleton-avatar" />
                  <div className="software-skeleton-copy">
                    <Skeleton className="skeleton-line" />
                    <Skeleton className="skeleton-line short" />
                  </div>
                </div>
                <Skeleton className="software-skeleton-bar" />
                <Skeleton className="software-skeleton-bar" />
                <Skeleton className="software-skeleton-bar software-col-source" />
                <Skeleton className="software-skeleton-pill" />
              </div>
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="software-table">
            <div className="software-head">
              <button
                type="button"
                className={cx('software-head-sort', sort === 'name' && 'is-active')}
                onClick={() => changeSort('name')}
              >
                软件名称
                <SortMark active={sort === 'name'} direction={direction} />
              </button>
              <button
                type="button"
                className={cx('software-head-sort', sort === 'size' && 'is-active')}
                onClick={() => changeSort('size')}
              >
                文件大小
                <SortMark active={sort === 'size'} direction={direction} />
              </button>
              <button
                type="button"
                className={cx('software-head-sort', sort === 'date' && 'is-active')}
                onClick={() => changeSort('date')}
              >
                安装时间
                <SortMark active={sort === 'date'} direction={direction} />
              </button>
              <span className="software-col-source">安装来源</span>
              <span className="software-head-actions">操作</span>
            </div>

            {filtered.map((item) => {
              const busy = openingId === item.id
              return (
                <div className="software-row" key={item.id}>
                  <div className="software-name-cell">
                    <span className={cx('software-avatar', `avatar-${toneOf(item.name)}`)} aria-hidden="true">
                      {initialsOf(item.name)}
                    </span>
                    <div className="software-name-copy">
                      <b className="software-name" title={item.name}>
                        {item.name}
                      </b>
                      <span className="software-name-meta" title={metaLine(item)}>
                        {metaLine(item)}
                      </span>
                    </div>
                  </div>
                  <span className="software-size" title={item.estimatedBytes > 0 ? '注册表登记的估算大小' : undefined}>
                    {item.estimatedBytes > 0 ? formatBytes(item.estimatedBytes) : '—'}
                  </span>
                  <span className="software-date">{item.installDate || '—'}</span>
                  <span className="software-source software-col-source">{sourceLabel(item.source)}</span>
                  <div className="software-row-actions">
                    <button
                      type="button"
                      className="software-location-link"
                      onClick={() => openLocation(item)}
                      disabled={busy || Boolean(openingId)}
                      title={item.installLocation ? `安装位置：${item.installLocation}` : '打开安装目录'}
                    >
                      {busy ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />}
                      打开目录
                    </button>
                    <button
                      type="button"
                      className="software-uninstall-btn"
                      onClick={() => setPendingUninstall(item)}
                      disabled={!item.hasUninstall || uninstalling}
                      title={item.hasUninstall ? '调起软件自带的卸载程序' : '该软件未注册卸载程序，请前往安装目录手动卸载'}
                    >
                      {item.hasUninstall ? '一键卸载' : '无法卸载'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : error ? null : (
          <EmptyState
            icon={query || tab !== 'all' ? <Search size={26} /> : <Package size={26} />}
            title={query || tab !== 'all' ? '没有匹配的软件' : '没有读取到已安装软件'}
            description={
              query || tab !== 'all'
                ? '换个关键词或筛选条件再试试'
                : '软件列表来自卸载注册表，刷新后仍为空可检查系统注册表权限'
            }
            action={
              query || tab !== 'all' ? (
                <Button variant="secondary" size="sm" onClick={resetFilters}>
                  清除筛选
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={refresh} loading={refreshing}>
                  重新读取
                </Button>
              )
            }
          />
        )}

        <div className="software-foot">
          <div className="software-foot-note">
            <ShieldCheck size={14} />
            软件信息来自 Windows 卸载注册表；卸载由软件自带卸载程序完成，请按向导操作。
          </div>
          <span className="software-foot-meta">
            {report ? `更新于 ${timeAgo(report.scannedAt)} · 缓存 60 秒` : '本地读取'}
          </span>
        </div>
      </Card>

      <ConfirmDialog
        open={pendingUninstall !== null}
        onClose={() => {
          if (!uninstalling) setPendingUninstall(null)
        }}
        onConfirm={uninstall}
        title={`卸载「${pendingUninstall?.name ?? ''}」？`}
        confirmText="调起卸载程序"
        tone="amber"
        busy={uninstalling}
        icon={<Trash2 size={22} />}
      >
        <p>
          将启动该软件自带的卸载向导。卸载完成后，软件数据与配置可能一并被删除，无法由本工具恢复。
        </p>
        {pendingUninstall ? (
          <div className="confirm-list">
            <div className="confirm-list-item">
              <span>发布者</span>
              <b>{pendingUninstall.publisher || '未知'}</b>
            </div>
            <div className="confirm-list-item">
              <span>版本</span>
              <b>{pendingUninstall.version || '未知'}</b>
            </div>
          </div>
        ) : null}
        <p className="modal-note">请先保存正在编辑的文件。卸载向导可能显示在任务栏中，请留意系统提示。</p>
      </ConfirmDialog>
    </div>
  )
}
