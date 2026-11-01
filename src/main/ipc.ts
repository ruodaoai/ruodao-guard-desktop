import { BrowserWindow, app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type {
  AiConfigInput,
  JunkCategoryId,
  NetworkOptimizeInput,
  PerformanceOptimizeInput,
  VirusScanOptions
} from '@shared/types'
import {
  cancelAiChat,
  chatWithAi,
  getAiAccount,
  getAiConfig,
  loginAiAccount,
  logoutAiAccount,
  refreshAiModels,
  saveAiConfig,
  testAiConnection
} from './services/ai'
import { getLastHealthReport, onHealthProgress, runHealthCheck } from './services/health'
import { cleanJunk, getLastJunkReport, scanJunk } from './services/junk'
import {
  checkDriverUpdates,
  getLastDriverUpdateCheck,
  installDriverInf,
  installDriverUpdates,
  openDeviceManager,
  scanDrivers
} from './services/drivers'
import { getNetworkStatus, optimizeNetwork } from './services/network'
import { getPerformanceStatus, optimizePerformance } from './services/performance'
import { runPowerShell } from './services/powershell'
import { endProcesses, listProcesses } from './services/processes'
import { deleteQuarantine, listQuarantine, restoreQuarantine } from './services/quarantine'
import { fixRepairIssues, getLastRepairReport, listRepairRiskLog, scanRepair } from './services/repair'
import { listSoftware, openSoftwareLocation, uninstallSoftware } from './services/software'
import { configureStartupStore, listStartup, optimizeStartup, setStartupEnabled } from './services/startup'
import { getSystemSnapshot } from './services/system'
import {
  cancelVirusScan,
  createTestSample,
  getScanState,
  onScanProgress,
  quarantineScanThreats,
  readScanHistory,
  startVirusScan
} from './services/virus'

const JUNK_IDS = new Set<JunkCategoryId>(['user-temp', 'system-temp', 'browser-cache', 'thumbnails', 'crash-dumps'])

let registered = false

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

type Handler = (...args: any[]) => unknown

function handle(channel: string, handler: Handler): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await handler(...args)
      return { ok: true, data }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message || '操作失败，请稍后重试' }
    }
  })
}

function handleEvent(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await handler(event, ...args)
      return { ok: true, data }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message || '操作失败，请稍后重试' }
    }
  })
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label}无效`)
  return value.trim()
}

function requireRuodaoUrl(value: unknown): string {
  const raw = requireString(value, '链接')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('链接无效')
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('链接无效')
  const host = url.hostname.toLowerCase()
  if (host !== 'ruodao.com' && host !== 'www.ruodao.com') throw new Error('仅支持打开若道官网链接')
  return url.toString()
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error(`${label}无效`)
  if (!value.every((item) => typeof item === 'string' && item.length > 0)) throw new Error(`${label}无效`)
  return value as string[]
}

function requireJunkIds(value: unknown): JunkCategoryId[] {
  const ids = requireStringArray(value, '清理项目')
  const valid = ids.filter((id): id is JunkCategoryId => JUNK_IDS.has(id as JunkCategoryId))
  if (valid.length === 0) throw new Error('请选择要清理的项目')
  return valid
}

function requireScanOptions(value: unknown): VirusScanOptions {
  if (!value || typeof value !== 'object') throw new Error('查杀参数无效')
  const raw = value as Record<string, unknown>
  const mode = raw.mode
  if (mode !== 'quick' && mode !== 'full' && mode !== 'custom') throw new Error('未知的查杀模式')
  if (mode === 'custom') {
    return { mode, target: requireString(raw.target, '查杀目录') }
  }
  return { mode }
}

function requirePids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('进程列表无效')
  const pids = value.filter(
    (item): item is number => typeof item === 'number' && Number.isInteger(item) && item > 0 && item < 2 ** 31
  )
  if (pids.length !== value.length) throw new Error('进程标识无效')
  return [...new Set(pids)]
}

function requireBoolean(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] === true
}

function requireNetworkInput(value: unknown): NetworkOptimizeInput {
  if (!value || typeof value !== 'object') throw new Error('网络优化参数无效')
  const raw = value as Record<string, unknown>
  const input: NetworkOptimizeInput = {
    flushDns: requireBoolean(raw, 'flushDns'),
    resetProxy: requireBoolean(raw, 'resetProxy'),
    optimizeTcp: requireBoolean(raw, 'optimizeTcp'),
    resetWinsock: requireBoolean(raw, 'resetWinsock')
  }
  if (!input.flushDns && !input.resetProxy && !input.optimizeTcp && !input.resetWinsock) {
    throw new Error('请选择要执行的网络优化项目')
  }
  return input
}

function requirePerformanceInput(value: unknown): PerformanceOptimizeInput {
  if (!value || typeof value !== 'object') throw new Error('性能优化参数无效')
  const raw = value as Record<string, unknown>
  const input: PerformanceOptimizeInput = {}
  if (typeof raw.planGuid === 'string') {
    if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(raw.planGuid)) throw new Error('电源计划标识无效')
    input.planGuid = raw.planGuid
  }
  if (raw.visualEffects !== undefined) {
    if (raw.visualEffects !== 'performance' && raw.visualEffects !== 'balanced' && raw.visualEffects !== 'appearance') {
      throw new Error('视觉效果选项无效')
    }
    input.visualEffects = raw.visualEffects
  }
  if (!input.planGuid && !input.visualEffects) throw new Error('请选择要应用的性能优化项目')
  return input
}

function requireIssueIds(value: unknown): string[] {
  const ids = requireStringArray(value, '修复项目')
  if (ids.length > 100) throw new Error('一次最多修复 100 个项目')
  return ids
}

export function registerIpc(): void {
  if (registered) return
  registered = true

  const dataDir = app.getPath('userData')
  const desktop = app.getPath('desktop')
  let downloads = ''
  try {
    downloads = app.getPath('downloads')
  } catch {
    downloads = `${dataDir}\\Downloads`
  }
  configureStartupStore(dataDir)

  const scanContext = { dataDir, desktop, downloads }

  handle('app:info', () => ({
    name: '若道安全卫士',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dataDir,
    packaged: app.isPackaged
  }))

  handle('app:open-data-dir', async () => {
    const error = await shell.openPath(dataDir)
    if (error) throw new Error(error)
  })

  handle('app:relaunch-admin', async () => {
    if (process.platform !== 'win32') throw new Error('仅支持在 Windows 上以管理员身份启动')
    const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
    const exe = process.execPath
    const argumentList = app.isPackaged ? '' : `-ArgumentList ${quote(app.getAppPath())}`
    await runPowerShell(`Start-Process -FilePath ${quote(exe)} ${argumentList} -Verb RunAs`, 30000)
    setTimeout(() => app.quit(), 1200)
    return { ok: true, message: '正在以管理员身份重新启动若道安全卫士' }
  })

  handle('app:open-external', async (url: unknown) => {
    await shell.openExternal(requireRuodaoUrl(url))
  })

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  handleEvent('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handleEvent('window:is-maximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)

  handle('system:snapshot', () => getSystemSnapshot())

  handle('health:run', () => runHealthCheck(dataDir))
  handle('health:last', () => getLastHealthReport())

  handle('junk:scan', () => scanJunk())
  handle('junk:last', () => getLastJunkReport())
  handle('junk:clean', (ids: unknown) => cleanJunk(requireJunkIds(ids)))

  handle('software:list', (force: unknown) => listSoftware(force === true))
  handle('software:uninstall', (id: unknown) => uninstallSoftware(requireString(id, '软件标识')))
  handle('software:open-location', (id: unknown) => openSoftwareLocation(requireString(id, '软件标识')))

  handle('drivers:scan', (force: unknown) => scanDrivers(force === true))
  handle('drivers:check-updates', (force: unknown) => checkDriverUpdates(force === true))
  handle('drivers:last-updates', () => getLastDriverUpdateCheck())
  handle('drivers:install-updates', (ids: unknown) => installDriverUpdates(requireStringArray(ids, '驱动更新')))
  handleEvent('drivers:choose-inf', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '选择驱动 INF 文件',
      properties: ['openFile' as const],
      filters: [
        { name: '驱动程序信息文件', extensions: ['inf'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  handle('drivers:install-inf', (infPath: unknown) => installDriverInf(requireString(infPath, '驱动文件')))
  handle('drivers:open-device-manager', () => openDeviceManager())

  handle('startup:list', () => listStartup())
  handle('startup:set-enabled', (id: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('启动项状态无效')
    return setStartupEnabled(requireString(id, '启动项标识'), enabled)
  })
  handle('startup:optimize', () => optimizeStartup())

  handle('speed:processes', () => listProcesses())
  handle('speed:end-processes', (pids: unknown) => endProcesses(dataDir, requirePids(pids)))
  handle('speed:network', () => getNetworkStatus())
  handle('speed:optimize-network', (input: unknown) => optimizeNetwork(dataDir, requireNetworkInput(input)))
  handle('speed:performance', () => getPerformanceStatus())
  handle('speed:optimize-performance', (input: unknown) =>
    optimizePerformance(dataDir, requirePerformanceInput(input))
  )

  handle('repair:scan', () => scanRepair({ dataDir, desktop }))
  handle('repair:last', () => getLastRepairReport())
  handle('repair:fix', (ids: unknown) => fixRepairIssues({ dataDir, desktop }, requireIssueIds(ids)))
  handle('repair:risk-log', (limit: unknown) =>
    listRepairRiskLog(dataDir, typeof limit === 'number' ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20)
  )

  handle('virus:scan', (options: unknown) => startVirusScan(requireScanOptions(options), scanContext))
  handle('virus:cancel', () => cancelVirusScan())
  handle('virus:state', () => getScanState())
  handle('virus:quarantine', (ids: unknown) => quarantineScanThreats(requireStringArray(ids, '风险项'), dataDir))
  handle('virus:history', () => readScanHistory(dataDir))
  handle('virus:create-test-sample', () => createTestSample(downloads))
  handleEvent('virus:choose-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '选择要查杀的文件夹', properties: ['openDirectory' as const] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('quarantine:list', () => listQuarantine(dataDir))
  handle('quarantine:restore', async (ids: unknown) => {
    const outcome = await restoreQuarantine(dataDir, requireStringArray(ids, '隔离项目'))
    if (outcome.failed.length > 0) {
      return { ok: false, message: `已恢复 ${outcome.restored} 个，${outcome.failed.length} 个失败：${outcome.failed[0]}` }
    }
    return { ok: true, message: `已恢复 ${outcome.restored} 个文件` }
  })
  handle('quarantine:delete', async (ids: unknown) => {
    const outcome = await deleteQuarantine(dataDir, requireStringArray(ids, '隔离项目'))
    if (outcome.failed.length > 0) {
      return { ok: false, message: `已永久删除 ${outcome.deleted} 个，${outcome.failed.length} 个失败：${outcome.failed[0]}` }
    }
    return { ok: true, message: `已永久删除 ${outcome.deleted} 个文件` }
  })

  handle('ai:get-config', () => getAiConfig(dataDir))
  handle('ai:save-config', (input: unknown) => saveAiConfig(dataDir, input as AiConfigInput))
  handle('ai:test', (input: unknown) => testAiConnection(dataDir, input as AiConfigInput))
  handle('ai:account', () => getAiAccount(dataDir))
  handle('ai:login', (input: unknown) => loginAiAccount(dataDir, input))
  handle('ai:logout', () => logoutAiAccount(dataDir))
  handle('ai:refresh-models', () => refreshAiModels(dataDir))
  handleEvent('ai:chat', (event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('对话请求无效')
    const requestId = (request as Record<string, unknown>).requestId
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(requestId)) {
      throw new Error('对话请求标识无效')
    }
    return chatWithAi(dataDir, request, (delta) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', { requestId, delta })
    })
  })
  handle('ai:cancel', (requestId: unknown) => {
    cancelAiChat(requireString(requestId, '对话标识'))
  })

  onScanProgress((progress) => broadcast('virus:progress', progress))
  onHealthProgress((progress) => broadcast('health:progress', progress))
}
