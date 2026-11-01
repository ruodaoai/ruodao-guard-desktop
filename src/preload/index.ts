import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GuardApi } from '../shared/types'

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: string
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!result || result.ok !== true) {
    throw new Error(result?.error || '操作失败，请稍后重试')
  }
  return result.data as T
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: GuardApi = {
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => invoke<boolean>('window:toggle-maximize'),
    isMaximized: () => invoke<boolean>('window:is-maximized'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizeChange: (callback) => subscribe<boolean>('window:maximized', callback)
  },
  app: {
    info: () => invoke('app:info'),
    openDataDir: () => invoke('app:open-data-dir'),
    openExternal: (url) => invoke('app:open-external', url),
    relaunchAsAdmin: () => invoke('app:relaunch-admin')
  },
  system: {
    snapshot: () => invoke('system:snapshot')
  },
  health: {
    run: () => invoke('health:run'),
    last: () => invoke('health:last'),
    onProgress: (callback) => subscribe('health:progress', callback)
  },
  junk: {
    scan: () => invoke('junk:scan'),
    last: () => invoke('junk:last'),
    clean: (ids) => invoke('junk:clean', ids)
  },
  software: {
    list: (force) => invoke('software:list', force === true),
    uninstall: (id) => invoke('software:uninstall', id),
    openLocation: (id) => invoke('software:open-location', id)
  },
  drivers: {
    scan: (force) => invoke('drivers:scan', force === true),
    checkUpdates: (force) => invoke('drivers:check-updates', force === true),
    lastUpdateCheck: () => invoke('drivers:last-updates'),
    installUpdates: (ids) => invoke('drivers:install-updates', ids),
    chooseInf: () => invoke('drivers:choose-inf'),
    installInf: (infPath) => invoke('drivers:install-inf', infPath),
    openDeviceManager: () => invoke('drivers:open-device-manager')
  },
  startup: {
    list: (force) => invoke('startup:list', force === true),
    setEnabled: (id, enabled) => invoke('startup:set-enabled', id, enabled),
    optimize: () => invoke('startup:optimize')
  },
  speed: {
    processes: (force) => invoke('speed:processes', force === true),
    endProcesses: (pids) => invoke('speed:end-processes', pids),
    network: (force) => invoke('speed:network', force === true),
    optimizeNetwork: (input) => invoke('speed:optimize-network', input),
    performance: (force) => invoke('speed:performance', force === true),
    optimizePerformance: (input) => invoke('speed:optimize-performance', input)
  },
  repair: {
    scan: (force) => invoke('repair:scan', force === true),
    last: () => invoke('repair:last'),
    fix: (issueIds) => invoke('repair:fix', issueIds),
    riskLog: (limit) => invoke('repair:risk-log', limit)
  },
  virus: {
    scan: (options) => invoke('virus:scan', options),
    cancel: () => invoke('virus:cancel'),
    state: () => invoke('virus:state'),
    onProgress: (callback) => subscribe('virus:progress', callback),
    quarantine: (threatIds) => invoke('virus:quarantine', threatIds),
    quarantineList: () => invoke('quarantine:list'),
    restore: (ids) => invoke('quarantine:restore', ids),
    deleteQuarantine: (ids) => invoke('quarantine:delete', ids),
    history: () => invoke('virus:history'),
    createTestSample: () => invoke('virus:create-test-sample'),
    chooseFolder: () => invoke('virus:choose-folder')
  },
  ai: {
    getConfig: () => invoke('ai:get-config'),
    saveConfig: (input) => invoke('ai:save-config', input),
    testConnection: (input) => invoke('ai:test', input),
    chat: (request) => invoke('ai:chat', request),
    cancel: (requestId) => invoke('ai:cancel', requestId),
    onChunk: (callback) => subscribe('ai:chunk', callback),
    getAccount: () => invoke('ai:account'),
    login: (input) => invoke('ai:login', input),
    logout: () => invoke('ai:logout'),
    refreshModels: () => invoke('ai:refresh-models')
  }
}

contextBridge.exposeInMainWorld('ruodao', api)
