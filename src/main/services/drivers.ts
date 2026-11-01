import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ActionResult,
  DriverClassSummary,
  DriverDevice,
  DriverInstallResult,
  DriverReport,
  DriverStatus,
  DriverUpdate,
  DriverUpdateCheck
} from '@shared/types'
import { POWERSHELL_PATH, psJson } from './powershell'

interface RawDriverDevice {
  deviceId?: string
  name?: string
  className?: string
  manufacturer?: string
  deviceStatus?: string
  errorCode?: number
}

interface RawDriverRecord {
  deviceId?: string
  driverVersion?: string
  driverDate?: string
  provider?: string
  infName?: string
  signer?: string
  signed?: boolean | null
}

interface RawDriverScan {
  scannedAt?: number
  osName?: string
  isAdmin?: boolean
  devices?: RawDriverDevice | RawDriverDevice[]
}

interface RawSignedDrivers {
  drivers?: RawDriverRecord | RawDriverRecord[]
}

interface RawDriverUpdate {
  id?: string
  title?: string
  description?: string
  driverClass?: string
  manufacturer?: string
  model?: string
  driverDate?: string
  sizeBytes?: number
  downloaded?: boolean
  rebootRequired?: boolean
}

interface RawDriverUpdateCheck {
  checkedAt?: number
  updates?: RawDriverUpdate | RawDriverUpdate[]
}

interface HelperResult {
  ok?: boolean
  cancelled?: boolean
  message?: string
  installed?: string[]
  failed?: Array<{ title?: string; message?: string }>
  rebootRequired?: boolean
}

type HelperRequest = { kind: 'wua'; updateIds: string[] } | { kind: 'inf'; infPath: string }

const SCAN_TTL = 5 * 60_000
const UPDATE_TTL = 30 * 60_000
const MAX_INSTALL_UPDATES = 30
const MAX_INF_BYTES = 256 * 1024 * 1024
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CLASS_LABELS: Record<string, string> = {
  DISPLAY: '显示适配器',
  NET: '网络适配器',
  MEDIA: '声音、视频和游戏控制器',
  HDC: '存储控制器',
  SCSIADAPTER: '存储控制器',
  USB: 'USB 控制器',
  HIDCLASS: '人体学输入设备',
  BLUETOOTH: '蓝牙',
  BATTERY: '电池',
  KEYBOARD: '键盘',
  MOUSE: '鼠标',
  MONITOR: '监视器',
  FIRMWARE: '固件',
  SYSTEM: '系统设备',
  DISKDRIVE: '磁盘驱动器',
  CAMERA: '摄像头',
  IMAGE: '图像设备',
  PRINTER: '打印机',
  SMARTCARDREADER: '智能卡读取器',
  SECURITYDEVICES: '安全设备',
  UCM: 'USB 连接器管理器',
  COMPUTER: '计算机',
  PROCESSOR: '处理器',
  WCEUSBS: 'Windows CE USB 设备',
  XNACOMPOSITE: '游戏控制器',
  AUDIOENDPOINT: '音频端点'
}

const PROBLEM_LABELS: Record<number, string> = {
  1: '设备未配置',
  3: '驱动已损坏',
  9: '设备信息无效',
  10: '设备无法启动',
  12: '资源不足',
  14: '需要重启',
  18: '需要重装驱动',
  19: '注册表配置异常',
  21: '设备正在移除',
  22: '设备已被禁用',
  24: '驱动安装不完整',
  28: '未安装驱动',
  29: '固件资源不足',
  31: '驱动无法加载',
  32: '驱动加载失败',
  37: '驱动初始化失败',
  43: '设备已停止响应'
}

const DEVICE_SCRIPT = `
$devices = @(Get-CimInstance Win32_PnPEntity -Property Name,PNPClass,Manufacturer,Status,ConfigManagerErrorCode,PNPDeviceID)
$items = @()
foreach ($device in $devices) {
  $pnpId = [string]$device.PNPDeviceID
  if ([string]::IsNullOrWhiteSpace($pnpId)) { continue }
  $items += [PSCustomObject]@{
    deviceId = $pnpId
    name = [string]$device.Name
    className = [string]$device.PNPClass
    manufacturer = [string]$device.Manufacturer
    deviceStatus = [string]$device.Status
    errorCode = [int]$device.ConfigManagerErrorCode
  }
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
[PSCustomObject]@{
  scannedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  osName = ([string](Get-CimInstance Win32_OperatingSystem).Caption).Trim()
  isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  devices = @($items)
} | ConvertTo-Json -Depth 4 -Compress
`

const DRIVER_SCRIPT = `
$drivers = @(Get-CimInstance Win32_PnPSignedDriver -Property DeviceID,DriverVersion,DriverDate,DriverProviderName,InfName,IsSigned,Signer)
$items = @()
foreach ($driver in $drivers) {
  $deviceId = [string]$driver.DeviceID
  if ([string]::IsNullOrWhiteSpace($deviceId)) { continue }
  $driverDate = ''
  try {
    if ($driver.DriverDate) { $driverDate = ([datetime]$driver.DriverDate).ToString('yyyy-MM-dd') }
  } catch { $driverDate = '' }
  $items += [PSCustomObject]@{
    deviceId = $deviceId
    driverVersion = [string]$driver.DriverVersion
    driverDate = $driverDate
    provider = [string]$driver.DriverProviderName
    infName = [string]$driver.InfName
    signer = [string]$driver.Signer
    signed = [bool]$driver.IsSigned
  }
}
[PSCustomObject]@{ drivers = @($items) } | ConvertTo-Json -Depth 4 -Compress
`

const UPDATE_SCRIPT = `
$service = Get-Service -Name wuauserv -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Running') {
  throw 'Windows 更新服务（wuauserv）未运行，请先在服务中启动后重试'
}
$session = New-Object -ComObject Microsoft.Update.Session
$session.ClientApplicationID = 'Ruodao Guard'
$searcher = $session.CreateUpdateSearcher()
$searcher.Online = $true
$result = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")
$items = @()
foreach ($update in $result.Updates) {
  $driverDate = ''
  try {
    if ($update.DriverVerDate) { $driverDate = ([datetime]$update.DriverVerDate).ToString('yyyy-MM-dd') }
  } catch { $driverDate = '' }
  $items += [PSCustomObject]@{
    id = [string]$update.Identity.UpdateID
    title = [string]$update.Title
    description = [string]$update.Description
    driverClass = [string]$update.DriverClass
    manufacturer = [string]$update.DriverManufacturer
    model = [string]$update.DriverModel
    driverDate = $driverDate
    sizeBytes = [int64]$update.Size
    downloaded = [bool]$update.IsDownloaded
    rebootRequired = [bool]$update.RebootRequired
  }
}
[PSCustomObject]@{
  checkedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  updates = @($items)
} | ConvertTo-Json -Depth 4 -Compress
`

const INSTALL_HELPER = `
param(
  [Parameter(Mandatory = $true)][string]$RequestPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$requestDir = Split-Path -Parent $RequestPath
$resultPath = Join-Path $requestDir 'result.json'

function Write-Result {
  param($Value)
  $json = $Value | ConvertTo-Json -Depth 6 -Compress
  [IO.File]::WriteAllText($resultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function New-Result {
  param(
    [bool]$Ok,
    [string]$Message,
    [array]$Installed,
    [array]$Failed,
    [bool]$RebootRequired,
    [bool]$Cancelled
  )
  return [PSCustomObject]@{
    ok = $Ok
    cancelled = $Cancelled
    message = $Message
    installed = @($Installed)
    failed = @($Failed)
    rebootRequired = $RebootRequired
  }
}

try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $kind = [string]$request.kind

  if ($kind -eq 'inf') {
    $infPath = [string]$request.infPath
    if (-not (Test-Path -LiteralPath $infPath -PathType Leaf)) { throw '驱动文件不存在或已被移动' }
    $output = & "$env:SystemRoot\\System32\\pnputil.exe" /add-driver $infPath /install 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ok = ($code -eq 0 -or $code -eq 3010)
    $reboot = ($code -eq 3010) -or ($output -match 'reboot|restart|重启')
    $message = $output.Trim()
    if ([string]::IsNullOrWhiteSpace($message)) {
      $message = if ($ok) { '驱动安装命令已完成' } else { "pnputil 安装失败（代码 $code）" }
    }
    if ($message.Length -gt 1200) { $message = $message.Substring(0, 1200) }
    Write-Result (New-Result -Ok $ok -Message $message -Installed @() -Failed @() -RebootRequired $reboot -Cancelled $false)
    exit 0
  }

  if ($kind -ne 'wua') { throw '未知的驱动安装请求' }

  $ids = @($request.updateIds | ForEach-Object { ([string]$_).ToLowerInvariant() })
  if ($ids.Count -eq 0) { throw '未指定要安装的驱动更新' }

  $session = New-Object -ComObject Microsoft.Update.Session
  $session.ClientApplicationID = 'Ruodao Guard'
  $searcher = $session.CreateUpdateSearcher()
  $searcher.Online = $true
  $searchResult = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")
  $selected = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($update in $searchResult.Updates) {
    $updateId = ([string]$update.Identity.UpdateID).ToLowerInvariant()
    if ($ids -contains $updateId) {
      if (-not $update.EulaAccepted) { $update.AcceptEula() }
      [void]$selected.Add($update)
    }
  }

  if ($selected.Count -eq 0) {
    Write-Result (New-Result -Ok $false -Message '未在 Windows 更新中找到所选驱动，可能已安装或已被下架' -Installed @() -Failed @() -RebootRequired $false -Cancelled $false)
    exit 0
  }

  $downloader = $session.CreateUpdateDownloader()
  $downloader.Updates = $selected
  $downloadResult = $downloader.Download()
  if ($downloadResult.ResultCode -ne 2 -and $downloadResult.ResultCode -ne 3) {
    throw "下载驱动失败（代码 $($downloadResult.ResultCode)）"
  }

  $installer = $session.CreateUpdateInstaller()
  $installer.Updates = $selected
  $installResult = $installer.Install()

  $installed = @()
  $failed = @()
  for ($index = 0; $index -lt $selected.Count; $index++) {
    $update = $selected.Item($index)
    $itemResult = $installResult.GetUpdateResult($index)
    if ($itemResult.ResultCode -eq 2 -or $itemResult.ResultCode -eq 3) {
      $installed += [string]$update.Title
    } else {
      $failed += [PSCustomObject]@{
        title = [string]$update.Title
        message = "安装失败（代码 $($itemResult.ResultCode)）"
      }
    }
  }

  $reboot = [bool]$installResult.RebootRequired
  if (-not $reboot) { $reboot = [bool]$installer.RebootRequired }
  if ($failed.Count -eq 0) {
    $message = if ($installed.Count -eq 1) { '驱动安装完成' } else { "已安装 $($installed.Count) 个驱动更新" }
  } else {
    $message = "已安装 $($installed.Count) 个，$($failed.Count) 个失败"
  }
  Write-Result (New-Result -Ok ($failed.Count -eq 0) -Message $message -Installed $installed -Failed $failed -RebootRequired $reboot -Cancelled $false)
} catch {
  Write-Result (New-Result -Ok $false -Message $_.Exception.Message -Installed @() -Failed @() -RebootRequired $false -Cancelled $false)
}
`

let scanCache: { at: number; report: DriverReport } | null = null
let scanInflight: Promise<DriverReport> | null = null
let updateCache: DriverUpdateCheck | null = null
let updateCacheAt = 0
let updateInflight: Promise<DriverUpdateCheck> | null = null

function classLabelFor(className: string): string {
  const key = className.trim().toUpperCase()
  return CLASS_LABELS[key] ?? '其他设备'
}

function cleanManufacturer(value: string | undefined): string {
  const text = (value || '').replace(/^"|"$/g, '').trim()
  if (!text) return ''
  if (/^\(standard system devices\)$/i.test(text)) return '标准系统设备'
  if (/^\(standard computers\)$/i.test(text)) return '标准计算机'
  return text
}

function normalizeDate(value: string | undefined): string {
  const text = (value || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const match = /^\/Date\((-?\d+)\)\/$/.exec(text)
  if (!match) return ''
  const date = new Date(Number(match[1]))
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function evaluateStatus(errorCode: number, signed: boolean | null, deviceStatus: string): {
  status: DriverStatus
  statusLabel: string
} {
  if (errorCode !== 0) {
    return { status: 'problem', statusLabel: PROBLEM_LABELS[errorCode] ?? '设备状态异常' }
  }
  if (signed === false) return { status: 'warning', statusLabel: '驱动未签名' }
  if (deviceStatus && deviceStatus.toUpperCase() !== 'OK') return { status: 'warning', statusLabel: '设备状态异常' }
  return { status: 'ok', statusLabel: '运行正常' }
}

function toDevice(raw: RawDriverDevice, driver: RawDriverRecord | undefined): DriverDevice | null {
  const deviceId = (raw.deviceId || '').trim()
  if (!deviceId) return null
  const className = (raw.className || '').trim()
  const classLabel = classLabelFor(className)
  const name = (raw.name || '').trim() || (className ? `${classLabel}设备` : '未命名设备')
  const errorCode = Number(raw.errorCode) || 0
  const driverVersion = (driver?.driverVersion || '').trim()
  const driverProvider = (driver?.provider || '').trim()
  const infName = (driver?.infName || '').trim()
  const hasDriverMeta = Boolean(driverVersion || driverProvider || infName)
  const signed = hasDriverMeta ? (driver?.signed === true ? true : driver?.signed === false ? false : null) : null
  const { status, statusLabel } = evaluateStatus(errorCode, signed, (raw.deviceStatus || '').trim())
  return {
    id: createHash('sha1').update(deviceId).digest('hex').slice(0, 16),
    name,
    className,
    classLabel,
    manufacturer: cleanManufacturer(raw.manufacturer),
    driverVersion,
    driverDate: normalizeDate(driver?.driverDate),
    driverProvider,
    infName,
    signed,
    signer: (driver?.signer || '').trim(),
    status,
    statusLabel,
    problemCode: errorCode,
    deviceId
  }
}

function compareDevices(a: DriverDevice, b: DriverDevice): number {
  const rank: Record<DriverStatus, number> = { problem: 0, warning: 1, ok: 2 }
  const statusDiff = rank[a.status] - rank[b.status]
  if (statusDiff !== 0) return statusDiff
  const classDiff = a.classLabel.localeCompare(b.classLabel, 'zh-CN')
  if (classDiff !== 0) return classDiff
  return a.name.localeCompare(b.name, 'zh-CN')
}

function buildReport(raw: RawDriverScan | null, signedRaw: RawSignedDrivers | null): DriverReport {
  const excludedClasses = new Set(['SoftwareComponent', 'SoftwareDevice', 'PrintQueue', 'Volume', 'SecurityDevices', 'Processor'])
  const driverMap = new Map<string, RawDriverRecord>()
  const driverList = signedRaw?.drivers
    ? Array.isArray(signedRaw.drivers)
      ? signedRaw.drivers
      : [signedRaw.drivers]
    : []
  for (const driver of driverList) {
    const key = (driver.deviceId || '').trim().toUpperCase()
    if (key && !driverMap.has(key)) driverMap.set(key, driver)
  }

  const list = raw?.devices ? (Array.isArray(raw.devices) ? raw.devices : [raw.devices]) : []
  const seen = new Set<string>()
  const devices: DriverDevice[] = []
  for (const entry of list) {
    const deviceId = (entry.deviceId || '').trim()
    if (!deviceId) continue
    if (deviceId.startsWith('ROOT\\') || deviceId.startsWith('SWD\\')) continue
    if (excludedClasses.has((entry.className || '').trim())) continue
    const key = deviceId.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    const device = toDevice(entry, driverMap.get(key))
    if (!device) continue
    devices.push(device)
  }
  devices.sort(compareDevices)

  const classMap = new Map<string, DriverClassSummary>()
  for (const device of devices) {
    const key = device.className || 'other'
    const existing = classMap.get(key)
    if (existing) {
      existing.count++
      if (device.status !== 'ok') existing.attention++
    } else {
      classMap.set(key, {
        className: device.className,
        classLabel: device.classLabel,
        count: 1,
        attention: device.status === 'ok' ? 0 : 1
      })
    }
  }
  const classes = [...classMap.values()].sort(
    (a, b) => b.count - a.count || a.classLabel.localeCompare(b.classLabel, 'zh-CN')
  )

  const problems = devices.filter((device) => device.status === 'problem').length
  const unsigned = devices.filter((device) => device.signed === false).length
  return {
    scannedAt: raw?.scannedAt || Date.now(),
    osName: (raw?.osName || 'Windows').replace(/^Microsoft\s+/, '').trim(),
    isAdmin: raw?.isAdmin === true,
    devices,
    classes,
    summary: {
      total: devices.length,
      attention: devices.filter((device) => device.status !== 'ok').length,
      problems,
      unsigned
    }
  }
}

async function buildScan(): Promise<DriverReport> {
  const [deviceResult, driverResult] = await Promise.allSettled([
    psJson<RawDriverScan>(DEVICE_SCRIPT, 60000),
    psJson<RawSignedDrivers>(DRIVER_SCRIPT, 60000)
  ])
  if (deviceResult.status === 'rejected') throw deviceResult.reason
  if (!deviceResult.value) throw new Error('未能读取硬件设备信息')
  const drivers = driverResult.status === 'fulfilled' ? driverResult.value : null
  const report = buildReport(deviceResult.value, drivers)
  scanCache = { at: Date.now(), report }
  return report
}

export async function scanDrivers(force = false): Promise<DriverReport> {
  if (!force && scanCache && Date.now() - scanCache.at < SCAN_TTL) return scanCache.report
  if (scanInflight) return scanInflight
  scanInflight = buildScan().finally(() => {
    scanInflight = null
  })
  return scanInflight
}

function toUpdate(raw: RawDriverUpdate): DriverUpdate | null {
  const id = (raw.id || '').trim()
  const title = (raw.title || '').trim()
  if (!id || !title) return null
  const driverClass = (raw.driverClass || '').trim()
  return {
    id,
    title,
    description: (raw.description || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    driverClass,
    classLabel: classLabelFor(driverClass),
    manufacturer: (raw.manufacturer || '').trim(),
    model: (raw.model || '').trim(),
    driverDate: normalizeDate(raw.driverDate),
    sizeBytes: Math.max(0, Number(raw.sizeBytes) || 0),
    downloaded: raw.downloaded === true,
    rebootRequired: raw.rebootRequired === true
  }
}

async function buildUpdateCheck(): Promise<DriverUpdateCheck> {
  let raw: RawDriverUpdateCheck | null
  try {
    raw = await psJson<RawDriverUpdateCheck>(UPDATE_SCRIPT, 120000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/超时/.test(message)) {
      throw new Error('检查驱动更新超时：Windows 更新响应较慢，请稍后重试')
    }
    throw new Error(`无法查询 Windows 更新：${message}`)
  }
  const list = raw?.updates ? (Array.isArray(raw.updates) ? raw.updates : [raw.updates]) : []
  const updates = list
    .map(toUpdate)
    .filter((item): item is DriverUpdate => item !== null)
    .sort((a, b) => a.classLabel.localeCompare(b.classLabel, 'zh-CN') || a.title.localeCompare(b.title, 'zh-CN'))
  const result: DriverUpdateCheck = {
    checkedAt: raw?.checkedAt || Date.now(),
    updates,
    message:
      updates.length > 0
        ? `Windows 更新发现 ${updates.length} 个可用驱动更新`
        : 'Windows 更新暂无适用于此电脑的驱动更新'
  }
  updateCache = result
  updateCacheAt = Date.now()
  return result
}

export async function checkDriverUpdates(force = false): Promise<DriverUpdateCheck> {
  if (!force && updateCache && Date.now() - updateCacheAt < UPDATE_TTL) return updateCache
  if (updateInflight) return updateInflight
  updateInflight = buildUpdateCheck().finally(() => {
    updateInflight = null
  })
  return updateInflight
}

export function getLastDriverUpdateCheck(): DriverUpdateCheck | null {
  return updateCache
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function isElevationCancel(text: string): boolean {
  return /取消|cancel|0x800704c7|拒绝|denied/i.test(text)
}

function normalizeInstallResult(raw: HelperResult | null, fallback: string): DriverInstallResult {
  if (!raw) {
    return { ok: false, message: fallback, installed: [], failed: [], rebootRequired: false, cancelled: false }
  }
  const installed = Array.isArray(raw.installed) ? raw.installed.filter((item): item is string => typeof item === 'string') : []
  const failed = Array.isArray(raw.failed)
    ? raw.failed.map((item) => ({
        title: typeof item?.title === 'string' && item.title ? item.title : '驱动更新',
        message: typeof item?.message === 'string' && item.message ? item.message : '安装失败'
      }))
    : []
  const cancelled = raw.cancelled === true
  const ok = raw.ok === true
  const message =
    (typeof raw.message === 'string' && raw.message.trim()) ||
    (ok ? '驱动安装完成' : cancelled ? '已取消管理员授权，未安装任何驱动' : fallback)
  return {
    ok,
    message,
    installed,
    failed,
    rebootRequired: raw.rebootRequired === true,
    cancelled
  }
}

interface ProcessResult {
  code: number
  stderr: string
  timedOut: boolean
}

function runLauncher(scriptPath: string, requestPath: string, timeoutMs: number): Promise<ProcessResult> {
  const argumentLine = `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" -RequestPath "${requestPath}"`
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$process = Start-Process -FilePath ${psQuote(
      POWERSHELL_PATH
    )} -ArgumentList ${psQuote(argumentLine)} -Verb RunAs -WindowStyle Hidden -PassThru -Wait`,
    'exit $process.ExitCode'
  ].join('; ')

  return new Promise<ProcessResult>((resolve) => {
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const child = spawn(POWERSHELL_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, stderr: stderr.trim(), timedOut })
    }
    timer = setTimeout(() => {
      timedOut = true
      child.kill()
      finish(-1)
    }, timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk
    })
    child.once('error', (error) => {
      stderr += error.message
      finish(-1)
    })
    child.once('close', (code) => finish(code ?? -1))
  })
}

async function runElevatedHelper(request: HelperRequest): Promise<DriverInstallResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruodao-driver-'))
  const requestPath = path.join(dir, `${randomUUID()}.json`)
  const scriptPath = path.join(dir, 'install-driver.ps1')
  const resultPath = path.join(dir, 'result.json')
  try {
    await fs.writeFile(requestPath, JSON.stringify(request), 'utf8')
    await fs.writeFile(scriptPath, `\uFEFF${INSTALL_HELPER}`, 'utf8')
    const process = await runLauncher(scriptPath, requestPath, 10 * 60_000)

    let raw: HelperResult | null = null
    try {
      const text = await fs.readFile(resultPath, 'utf8')
      raw = JSON.parse(text.replace(/^\uFEFF/, '')) as HelperResult
    } catch {
      raw = null
    }

    if (!raw) {
      if (process.timedOut) {
        return {
          ok: false,
          cancelled: false,
          message: '驱动安装等待超时，请稍后重新扫描设备状态；若已授权，安装可能仍在后台进行',
          installed: [],
          failed: [],
          rebootRequired: false
        }
      }
      if (isElevationCancel(process.stderr)) {
        return {
          ok: false,
          cancelled: true,
          message: '已取消管理员授权，未安装任何驱动',
          installed: [],
          failed: [],
          rebootRequired: false
        }
      }
      const detail = process.stderr.replace(/\s+/g, ' ').trim().slice(0, 240)
      return normalizeInstallResult(
        null,
        detail || `驱动安装程序未返回结果（退出代码 ${process.code}），请稍后重试`
      )
    }
    return normalizeInstallResult(raw, '驱动安装未完成，请查看 Windows 更新后重试')
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function installDriverUpdates(ids: string[]): Promise<DriverInstallResult> {
  const unique = [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))]
  if (unique.length === 0) throw new Error('请选择要安装的驱动更新')
  if (unique.length > MAX_INSTALL_UPDATES) throw new Error(`一次最多安装 ${MAX_INSTALL_UPDATES} 个驱动更新`)
  if (!unique.every((id) => GUID_PATTERN.test(id))) throw new Error('驱动更新标识无效，请重新检查更新')
  const result = await runElevatedHelper({ kind: 'wua', updateIds: unique })
  if (result.ok) {
    scanCache = null
    updateCache = null
    updateCacheAt = 0
  }
  return result
}

export async function installDriverInf(infPath: string): Promise<DriverInstallResult> {
  const resolved = path.resolve(infPath.trim())
  if (!/\.inf$/i.test(resolved)) throw new Error('请选择 .inf 驱动信息文件')
  let stat
  try {
    stat = await fs.stat(resolved)
  } catch {
    throw new Error('驱动文件不存在或无法访问')
  }
  if (!stat.isFile()) throw new Error('所选路径不是驱动文件')
  if (stat.size > MAX_INF_BYTES) throw new Error('驱动文件过大，请选择有效的 INF 文件')
  const result = await runElevatedHelper({ kind: 'inf', infPath: resolved })
  if (result.ok) scanCache = null
  return result
}

export async function openDeviceManager(): Promise<ActionResult> {
  try {
    const executable = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\mmc.exe` : 'mmc.exe'
    const child = spawn(executable, ['devmgmt.msc'], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { ok: true, message: '已打开设备管理器' }
  } catch (error) {
    return { ok: false, message: `无法打开设备管理器：${(error as Error).message}` }
  }
}
