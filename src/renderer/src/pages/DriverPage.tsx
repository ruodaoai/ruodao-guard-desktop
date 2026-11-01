import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  BatteryCharging,
  Bluetooth,
  Camera,
  CheckCircle2,
  CircuitBoard,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Info,
  Keyboard,
  Loader2,
  Monitor,
  MonitorCog,
  Mouse,
  Network,
  Printer,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Usb,
  Volume2,
  X
} from 'lucide-react'
import type { DriverDevice, DriverReport, DriverStatus, DriverUpdateCheck } from '@shared/types'
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  Modal,
  ProgressBar,
  Skeleton
} from '../components/ui'
import { useToast } from '../components/Toast'
import { cx, errorMessage, formatBytes, shortPath, timeAgo } from '../lib/format'

type DriverTab = 'all' | 'attention' | 'unsigned'

const TABS: ReadonlyArray<{ id: DriverTab; label: string }> = [
  { id: 'all', label: '全部设备' },
  { id: 'attention', label: '需要关注' },
  { id: 'unsigned', label: '未签名' }
]

const CLASS_TONES: Record<string, string> = {
  DISPLAY: 'blue',
  NET: 'teal',
  MEDIA: 'violet',
  USB: 'amber',
  BLUETOOTH: 'blue',
  SYSTEM: 'green',
  FIRMWARE: 'rose',
  DISKDRIVE: 'amber',
  SCSIADAPTER: 'amber',
  HDC: 'amber',
  HIDCLASS: 'teal',
  KEYBOARD: 'green',
  MOUSE: 'green',
  BATTERY: 'green',
  PRINTER: 'violet',
  CAMERA: 'rose',
  IMAGE: 'rose',
  MONITOR: 'blue',
  UCM: 'teal'
}

function ClassIcon({ className, size = 18 }: { className: string; size?: number }): React.JSX.Element {
  const key = className.toUpperCase()
  const props = { size, strokeWidth: 2 }
  if (key === 'DISPLAY' || key === 'MONITOR') return <Monitor {...props} />
  if (key === 'NET') return <Network {...props} />
  if (key === 'MEDIA') return <Volume2 {...props} />
  if (key === 'USB' || key === 'UCM') return <Usb {...props} />
  if (key === 'BLUETOOTH') return <Bluetooth {...props} />
  if (key === 'BATTERY') return <BatteryCharging {...props} />
  if (key === 'KEYBOARD') return <Keyboard {...props} />
  if (key === 'MOUSE' || key === 'HIDCLASS') return <Mouse {...props} />
  if (key === 'PRINTER') return <Printer {...props} />
  if (key === 'CAMERA' || key === 'IMAGE') return <Camera {...props} />
  if (key === 'DISKDRIVE' || key === 'SCSIADAPTER' || key === 'HDC') return <HardDrive {...props} />
  if (key === 'SYSTEM' || key === 'PROCESSOR') return <Cpu {...props} />
  return <CircuitBoard {...props} />
}

function classTone(className: string): string {
  return CLASS_TONES[className.toUpperCase()] ?? 'green'
}

function statusTone(status: DriverStatus): 'green' | 'amber' | 'red' {
  if (status === 'problem') return 'red'
  if (status === 'warning') return 'amber'
  return 'green'
}

function StatusIcon({ status }: { status: DriverStatus }): React.JSX.Element {
  if (status === 'problem') return <ShieldAlert size={11} />
  if (status === 'warning') return <AlertTriangle size={11} />
  return <CheckCircle2 size={11} />
}

function deviceMeta(device: DriverDevice): string {
  const parts: string[] = []
  if (device.manufacturer) parts.push(device.manufacturer)
  if (device.driverProvider && device.driverProvider !== device.manufacturer) parts.push(device.driverProvider)
  if (parts.length === 0 && device.infName) parts.push(device.infName)
  return parts.join(' · ') || '系统内置驱动'
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function toastText(value: string, limit = 180): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export function DriverPage(): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [report, setReport] = useState<DriverReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<DriverTab>('all')
  const [updateCheck, setUpdateCheck] = useState<DriverUpdateCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [installOpen, setInstallOpen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [choosingInf, setChoosingInf] = useState(false)
  const [pendingInf, setPendingInf] = useState<string | null>(null)
  const [detail, setDetail] = useState<DriverDevice | null>(null)
  const [rebootNote, setRebootNote] = useState(false)

  useEffect(() => {
    let alive = true
    Promise.allSettled([api.drivers.scan(), api.drivers.lastUpdateCheck()]).then(([scanResult, updateResult]) => {
      if (!alive) return
      if (scanResult.status === 'fulfilled') {
        setReport(scanResult.value)
      } else {
        const message = errorMessage(scanResult.reason)
        setScanError(message)
        toast.push('error', message)
      }
      if (updateResult.status === 'fulfilled' && updateResult.value) {
        setUpdateCheck(updateResult.value)
        setSelected(updateResult.value.updates.map((update) => update.id))
      }
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [api, toast])

  const devices = report?.devices ?? []
  const updates = updateCheck?.updates ?? []
  const summary = report?.summary
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const selectedUpdates = useMemo(
    () => updates.filter((update) => selectedSet.has(update.id)),
    [updates, selectedSet]
  )
  const selectedBytes = useMemo(
    () => selectedUpdates.reduce((sum, update) => sum + update.sizeBytes, 0),
    [selectedUpdates]
  )
  const allSelected = updates.length > 0 && selected.length === updates.length

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return devices.filter((device) => {
      if (tab === 'attention' && device.status === 'ok') return false
      if (tab === 'unsigned' && device.signed !== false) return false
      if (!keyword) return true
      return [
        device.name,
        device.manufacturer,
        device.driverProvider,
        device.driverVersion,
        device.classLabel,
        device.deviceId
      ].some((value) => value.toLowerCase().includes(keyword))
    })
  }, [devices, query, tab])

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setScanError(null)
    try {
      const data = await api.drivers.scan(true)
      setReport(data)
      toast.push('success', `硬件扫描完成，共 ${data.summary.total} 个设备`)
    } catch (refreshError) {
      const message = errorMessage(refreshError)
      setScanError(message)
      toast.push('error', message)
    } finally {
      setRefreshing(false)
    }
  }

  const rescanSilently = (): void => {
    if (refreshing) return
    setRefreshing(true)
    api.drivers
      .scan(true)
      .then((data) => {
        setReport(data)
        setScanError(null)
      })
      .catch(() => undefined)
      .finally(() => setRefreshing(false))
  }

  const checkUpdates = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    setUpdateError(null)
    try {
      const result = await api.drivers.checkUpdates(true)
      setUpdateCheck(result)
      setSelected(result.updates.map((update) => update.id))
      toast.push(result.updates.length > 0 ? 'success' : 'info', result.message)
    } catch (checkError) {
      const message = errorMessage(checkError)
      setUpdateError(message)
      toast.push('error', message)
    } finally {
      setChecking(false)
    }
  }

  const installSelected = async (): Promise<void> => {
    if (installing || selected.length === 0) return
    setInstalling(true)
    try {
      const result = await api.drivers.installUpdates(selected)
      toast.push(
        result.ok ? 'success' : result.cancelled ? 'info' : 'error',
        toastText(`${result.message}${result.rebootRequired ? '，部分驱动需重启后生效' : ''}`)
      )
      setInstallOpen(false)
      if (result.ok || result.installed.length > 0) {
        setRebootNote(result.rebootRequired)
        setUpdateCheck(null)
        setSelected([])
        rescanSilently()
      }
    } catch (installError) {
      toast.push('error', errorMessage(installError))
      setInstallOpen(false)
    } finally {
      setInstalling(false)
    }
  }

  const chooseInf = async (): Promise<void> => {
    if (choosingInf) return
    setChoosingInf(true)
    try {
      const chosen = await api.drivers.chooseInf()
      if (chosen) setPendingInf(chosen)
    } catch (chooseError) {
      toast.push('error', errorMessage(chooseError))
    } finally {
      setChoosingInf(false)
    }
  }

  const installInf = async (): Promise<void> => {
    if (!pendingInf || installing) return
    setInstalling(true)
    try {
      const result = await api.drivers.installInf(pendingInf)
      toast.push(
        result.ok ? 'success' : 'error',
        toastText(`${result.message}${result.rebootRequired ? '，请重启电脑后生效' : ''}`)
      )
      setPendingInf(null)
      if (result.ok) {
        setRebootNote(result.rebootRequired)
        rescanSilently()
      }
    } catch (installError) {
      toast.push('error', errorMessage(installError))
      setPendingInf(null)
    } finally {
      setInstalling(false)
    }
  }

  const openDeviceManager = async (): Promise<void> => {
    try {
      const result = await api.drivers.openDeviceManager()
      if (!result.ok) toast.push('error', result.message)
    } catch (openError) {
      toast.push('error', errorMessage(openError))
    }
  }

  const attention = summary?.attention ?? 0
  const problems = summary?.problems ?? 0
  const unsignedCount = summary?.unsigned ?? 0
  const total = summary?.total ?? 0
  const headline = loading
    ? '正在扫描硬件设备'
    : scanError && !report
      ? '硬件扫描未完成'
      : attention > 0
        ? `${attention} 个设备需要关注`
        : '驱动状态良好'
  const description = loading
    ? '正在读取 Windows PnP 设备与已安装驱动，首次扫描约需十余秒…'
    : !report
      ? '未能读取硬件信息，请检查系统权限后重新扫描。'
      : problems > 0
        ? `发现 ${problems} 个设备存在驱动状态异常，建议查看详情并更新对应驱动。`
        : unsignedCount > 0
          ? `有 ${unsignedCount} 个设备使用未签名驱动，建议确认来源后再使用。`
          : `已检查 ${total} 个硬件设备及其驱动版本，当前未发现异常。`

  const tabCount = (id: DriverTab): number => {
    if (id === 'attention') return attention
    if (id === 'unsigned') return unsignedCount
    return total
  }
  const tabMeta = loading
    ? '扫描中…'
    : query.trim()
      ? `找到 ${filtered.length} 个设备`
      : `共 ${filtered.length} 个设备`

  return (
    <div className="page driver-page">
      <div className="page-header driver-page-header">
        <div>
          <h1 className="page-title">驱动管理</h1>
          <p className="page-subtitle">扫描硬件设备，检查驱动版本与签名状态，通过 Windows 更新或本地 INF 安装驱动</p>
        </div>
        <div className="page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<MonitorCog size={15} />}
            onClick={openDeviceManager}
          >
            设备管理器
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw size={15} />}
            onClick={refresh}
            loading={refreshing}
            disabled={loading}
          >
            {refreshing ? '扫描中' : '重新扫描'}
          </Button>
        </div>
      </div>

      <Card className="driver-shell">
        <div className="driver-overview">
          <div className="driver-summary-head">
            <div className="driver-summary-copy">
              <span className="driver-kicker">
                <CircuitBoard size={15} />
                硬件驱动扫描
                {report ? <span className="driver-os">{report.osName}</span> : null}
              </span>
              <h2>{headline}</h2>
              <p>{description}</p>
            </div>
            <div className="driver-metrics">
              <div className="driver-metric">
                <b>{loading ? '—' : total}</b>
                <span>设备总数</span>
              </div>
              <div className={cx('driver-metric', attention > 0 && 'is-warn')}>
                <b>{loading ? '—' : attention}</b>
                <span>需要关注</span>
              </div>
              <div className={cx('driver-metric', unsignedCount > 0 && 'is-warn')}>
                <b>{loading ? '—' : unsignedCount}</b>
                <span>未签名</span>
              </div>
              <div className="driver-metric">
                <b>{updateCheck ? updates.length : '—'}</b>
                <span>可用更新</span>
              </div>
            </div>
          </div>

          <div className="driver-tools">
            <label className="driver-search">
              <Search size={18} />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索设备名称、厂商或驱动版本"
                spellCheck={false}
                aria-label="搜索硬件设备"
              />
              {query ? (
                <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清除搜索">
                  <X size={15} />
                </button>
              ) : null}
            </label>
            <span className="driver-scan-time">
              {report ? `扫描于 ${timeAgo(report.scannedAt)} · 缓存 5 分钟` : loading ? '正在读取设备…' : '尚未完成扫描'}
            </span>
          </div>
        </div>

        <div className="driver-updates">
          <div className="driver-updates-head">
            <span className="driver-updates-icon">
              <Download size={18} />
            </span>
            <div className="driver-updates-copy">
              <b>驱动更新</b>
              <p>
                {updateCheck
                  ? `${updateCheck.message} · 检查于 ${timeAgo(updateCheck.checkedAt)}`
                  : '通过 Windows 更新查询 Microsoft 与设备厂商发布的驱动'}
              </p>
            </div>
            <div className="driver-updates-actions">
              <button
                type="button"
                className="driver-local-btn"
                onClick={chooseInf}
                disabled={choosingInf || checking || installing || loading}
                title="选择设备厂商提供的 .inf 驱动文件进行安装"
              >
                {choosingInf ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />}
                本地 INF
              </button>
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw size={14} />}
                onClick={checkUpdates}
                loading={checking}
                disabled={installing || loading}
              >
                {checking ? '正在查询…' : updateCheck ? '重新检查' : '检查更新'}
              </Button>
            </div>
          </div>

          {checking ? (
            <div className="driver-updates-progress">
              <div className="driver-progress-head">
                <span>正在连接 Windows 更新查询驱动…</span>
                <span>首次检查可能需要 1-2 分钟，请保持网络连接</span>
              </div>
              <ProgressBar value={0} indeterminate />
            </div>
          ) : updateError ? (
            <div className="driver-update-error">
              <AlertTriangle size={15} />
              <span>{updateError}</span>
              <button type="button" onClick={checkUpdates}>
                重试
              </button>
            </div>
          ) : updates.length > 0 ? (
            <>
              <div className="driver-update-toolbar">
                <label className="driver-check-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) => setSelected(event.target.checked ? updates.map((update) => update.id) : [])}
                    aria-label="全选驱动更新"
                  />
                  全选
                </label>
                <span className="driver-selected-meta">
                  已选 {selectedUpdates.length} 项
                  {selectedBytes > 0 ? ` · ${formatBytes(selectedBytes)}` : ''}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Download size={14} />}
                  onClick={() => setInstallOpen(true)}
                  disabled={selectedUpdates.length === 0 || installing}
                >
                  安装所选驱动
                </Button>
              </div>
              <div className="driver-update-list">
                {updates.map((update) => {
                  const checked = selectedSet.has(update.id)
                  return (
                    <label className={cx('driver-update-row', checked && 'is-selected')} key={update.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setSelected((previous) =>
                            event.target.checked
                              ? [...new Set([...previous, update.id])]
                              : previous.filter((id) => id !== update.id)
                          )
                        }
                        aria-label={`选择 ${update.title}`}
                      />
                      <span className="driver-update-copy">
                        <b title={update.description || update.title}>{update.title}</b>
                        <span>
                          {[
                            update.classLabel,
                            update.manufacturer || '未知厂商',
                            update.driverDate,
                            update.sizeBytes > 0 ? formatBytes(update.sizeBytes) : ''
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      {update.rebootRequired ? <Chip tone="amber">需重启</Chip> : null}
                    </label>
                  )
                })}
              </div>
            </>
          ) : updateCheck ? (
            <div className="driver-updates-empty">
              <CheckCircle2 size={16} />
              <span>{updateCheck.message}</span>
              <span className="driver-updates-empty-meta">检查于 {timeAgo(updateCheck.checkedAt)}</span>
            </div>
          ) : (
            <div className="driver-updates-idle">
              <Info size={15} />
              <span>尚未检查在线更新。点击「检查更新」通过 Windows 更新查询适用于此电脑的驱动。</span>
            </div>
          )}

          {rebootNote ? (
            <div className="driver-reboot-note">
              <Info size={15} />
              <span>部分驱动已安装，将在重启电脑后生效。</span>
            </div>
          ) : null}
        </div>

        <div className="driver-tabbar">
          <div className="driver-tabs" role="tablist" aria-label="设备筛选">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={cx('driver-tab', tab === item.id && 'driver-tab-active')}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                <span className="driver-tab-count">{loading ? '—' : tabCount(item.id)}</span>
              </button>
            ))}
          </div>
          <span className="driver-tab-meta">{tabMeta}</span>
        </div>

        {scanError ? (
          <div className="inline-error">
            <AlertTriangle size={16} />
            <span>{scanError}</span>
            <button type="button" onClick={refresh}>
              重试
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="driver-table" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="driver-skeleton-row" key={index}>
                <div className="driver-name-cell">
                  <Skeleton className="driver-skeleton-avatar" />
                  <div className="driver-skeleton-copy">
                    <Skeleton className="skeleton-line" />
                    <Skeleton className="skeleton-line short" />
                  </div>
                </div>
                <Skeleton className="driver-skeleton-bar driver-col-class" />
                <Skeleton className="driver-skeleton-bar driver-col-version" />
                <Skeleton className="driver-skeleton-bar driver-col-date" />
                <Skeleton className="driver-skeleton-chip" />
                <Skeleton className="driver-skeleton-link" />
              </div>
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="driver-table">
            <div className="driver-head">
              <span>设备名称</span>
              <span className="driver-col-class">设备类别</span>
              <span className="driver-col-version">驱动版本</span>
              <span className="driver-col-date">驱动日期</span>
              <span>状态</span>
              <span className="driver-head-action">操作</span>
            </div>
            {filtered.map((device) => (
              <div className="driver-row" key={device.id}>
                <div className="driver-name-cell">
                  <span className={cx('driver-avatar', `avatar-${classTone(device.className)}`)} aria-hidden="true">
                    <ClassIcon className={device.className} />
                  </span>
                  <div className="driver-name-copy">
                    <b className="driver-name" title={device.name}>
                      {device.name}
                    </b>
                    <span className="driver-name-meta" title={deviceMeta(device)}>
                      {deviceMeta(device)}
                    </span>
                  </div>
                </div>
                <span className="driver-class driver-col-class">{device.classLabel}</span>
                <span className="driver-version driver-col-version" title={device.driverVersion || '未读取到驱动版本'}>
                  {device.driverVersion || '—'}
                </span>
                <span className="driver-date driver-col-date">{device.driverDate || '—'}</span>
                <span className="driver-status-cell">
                  <Chip
                    tone={statusTone(device.status)}
                    className="driver-status-chip"
                  >
                    <StatusIcon status={device.status} />
                    <span title={device.problemCode !== 0 ? `问题代码 ${device.problemCode}` : undefined}>
                      {device.statusLabel}
                    </span>
                  </Chip>
                </span>
                <button type="button" className="driver-detail-btn" onClick={() => setDetail(device)}>
                  详情
                </button>
              </div>
            ))}
          </div>
        ) : scanError ? null : (
          <EmptyState
            icon={query || tab !== 'all' ? <Search size={26} /> : <CircuitBoard size={26} />}
            title={query || tab !== 'all' ? '没有符合条件的设备' : '没有读取到硬件设备'}
            description={
              query || tab !== 'all'
                ? '换个关键词或筛选条件再试试'
                : '设备信息来自 Windows PnP，重新扫描后仍为空请检查系统权限'
            }
            action={
              query || tab !== 'all' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setQuery('')
                    setTab('all')
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={refresh} loading={refreshing}>
                  重新扫描
                </Button>
              )
            }
          />
        )}

        <div className="driver-foot">
          <div className="driver-foot-note">
            <ShieldCheck size={14} />
            设备信息读取自 Windows PnP；驱动更新由 Windows 更新提供，安装需要管理员权限并会触发 UAC 确认。
          </div>
          <span className="driver-foot-meta">
            {report ? `${report.devices.length} 个设备 · 扫描于 ${timeAgo(report.scannedAt)}` : '本地读取'}
          </span>
        </div>
      </Card>

      <ConfirmDialog
        open={installOpen}
        onClose={() => {
          if (!installing) setInstallOpen(false)
        }}
        onConfirm={installSelected}
        title={`安装 ${selectedUpdates.length} 个驱动更新？`}
        confirmText="安装驱动"
        tone="amber"
        busy={installing}
        icon={<Download size={22} />}
      >
        <p>
          将从 Windows 更新下载并安装所选驱动。安装需要管理员权限，Windows 会弹出 UAC 确认窗口，请选择「是」。
        </p>
        <div className="confirm-list">
          {selectedUpdates.slice(0, 4).map((update) => (
            <div className="confirm-list-item" key={update.id}>
              <span>{update.classLabel}</span>
              <b title={update.title}>{update.title}</b>
            </div>
          ))}
          {selectedUpdates.length > 4 ? (
            <div className="confirm-list-item">
              <span>其他</span>
              <b>另 ${selectedUpdates.length - 4} 个驱动更新</b>
            </div>
          ) : null}
        </div>
        <p className="modal-note">
          安装期间屏幕可能短暂闪烁；部分驱动需要重启电脑后生效。请确认设备厂商与版本后再继续。
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingInf !== null}
        onClose={() => {
          if (!installing) setPendingInf(null)
        }}
        onConfirm={installInf}
        title="从本地安装驱动？"
        confirmText="安装 INF 驱动"
        tone="amber"
        busy={installing}
        icon={<FolderOpen size={22} />}
      >
        <p>将使用 Windows PnP 工具安装所选 INF 驱动包，安装前需要管理员授权。</p>
        {pendingInf ? (
          <div className="confirm-list">
            <div className="confirm-list-item">
              <span>驱动文件</span>
              <b>{fileName(pendingInf)}</b>
            </div>
            <div className="confirm-list-item">
              <span>文件位置</span>
              <b title={pendingInf}>{shortPath(pendingInf, 18, 28)}</b>
            </div>
          </div>
        ) : null}
        <p className="modal-note">请仅安装来自设备厂商或可信来源的签名驱动，未签名驱动可能被 Windows 阻止。</p>
      </ConfirmDialog>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title="设备驱动详情"
        width={580}
        footer={
          <Button variant="secondary" onClick={() => setDetail(null)}>
            关闭
          </Button>
        }
      >
        {detail ? (
          <div className="driver-detail">
            <div className="driver-detail-head">
              <span className={cx('driver-detail-avatar', `avatar-${classTone(detail.className)}`)}>
                <ClassIcon className={detail.className} size={22} />
              </span>
              <div className="driver-detail-title">
                <b>{detail.name}</b>
                <span>
                  {detail.classLabel}
                  {detail.manufacturer ? ` · ${detail.manufacturer}` : ''}
                </span>
              </div>
              <Chip tone={statusTone(detail.status)}>
                <StatusIcon status={detail.status} />
                {detail.statusLabel}
              </Chip>
            </div>
            <div className="driver-detail-grid">
              <div className="driver-detail-item">
                <span>驱动版本</span>
                <b>{detail.driverVersion || '—'}</b>
              </div>
              <div className="driver-detail-item">
                <span>驱动日期</span>
                <b>{detail.driverDate || '—'}</b>
              </div>
              <div className="driver-detail-item">
                <span>驱动提供者</span>
                <b>{detail.driverProvider || '—'}</b>
              </div>
              <div className="driver-detail-item">
                <span>INF 文件</span>
                <b>{detail.infName || '—'}</b>
              </div>
              <div className="driver-detail-item">
                <span>数字签名</span>
                <b>{detail.signed === true ? '已签名' : detail.signed === false ? '未签名' : '未知'}</b>
              </div>
              <div className="driver-detail-item">
                <span>设备状态代码</span>
                <b>{detail.problemCode === 0 ? '0 · 正常' : `${detail.problemCode} · ${detail.statusLabel}`}</b>
              </div>
              <div className="driver-detail-item driver-detail-wide">
                <span>签名者</span>
                <b>{detail.signer || '—'}</b>
              </div>
              <div className="driver-detail-item driver-detail-wide">
                <span>设备实例 ID</span>
                <b className="driver-device-id">{detail.deviceId}</b>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
