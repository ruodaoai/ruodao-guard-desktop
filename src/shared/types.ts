export type PageId =
  | 'home'
  | 'assistant'
  | 'virus'
  | 'junk'
  | 'software'
  | 'drivers'
  | 'startup'
  | 'repair'
  | 'settings'

export interface DiskInfo {
  id: string
  label: string
  total: number
  free: number
}

export interface DefenderStatus {
  available: boolean
  realtime: boolean
  antivirusEnabled: boolean
  signatureVersion: string
  signatureUpdatedAt: string | null
}

export interface SystemSnapshot {
  hostname: string
  osName: string
  osVersion: string
  arch: string
  cpuModel: string
  cpuCores: number
  cpuUsage: number
  memoryTotal: number
  memoryUsed: number
  memoryPercent: number
  uptimeSec: number
  isAdmin: boolean
  disks: DiskInfo[]
  defender: DefenderStatus
  capturedAt: number
}

export interface HealthIssue {
  id: string
  title: string
  detail: string
  severity: 'low' | 'medium' | 'high'
  metric: string
  actionPage: PageId | null
  actionLabel: string | null
}

export interface HealthReport {
  score: number
  verdict: 'excellent' | 'good' | 'poor'
  checkedAt: number
  issues: HealthIssue[]
  junkBytes: number
  junkFiles: number
  startupCount: number
  threatCount: number
  lastScanAt: number | null
  snapshot: SystemSnapshot
}

export interface HealthProgress {
  stage: 'system' | 'junk' | 'startup' | 'protection' | 'score'
  label: string
  percent: number
}

export type JunkCategoryId =
  | 'user-temp'
  | 'system-temp'
  | 'browser-cache'
  | 'thumbnails'
  | 'crash-dumps'

export interface JunkItem {
  path: string
  bytes: number
}

export interface JunkCategory {
  id: JunkCategoryId
  name: string
  description: string
  bytes: number
  files: number
  items: JunkItem[]
  available: boolean
  note?: string
}

export interface JunkReport {
  scannedAt: number
  totalBytes: number
  totalFiles: number
  categories: JunkCategory[]
}

export interface CleanCategoryResult {
  id: JunkCategoryId
  name: string
  freedBytes: number
  deletedFiles: number
  skippedFiles: number
}

export interface CleanResult {
  freedBytes: number
  deletedFiles: number
  skippedFiles: number
  errors: string[]
  categories: CleanCategoryResult[]
  report: JunkReport
}

export interface SoftwareItem {
  id: string
  name: string
  version: string
  publisher: string
  installDate: string
  installLocation: string
  estimatedBytes: number
  source: 'machine' | 'machine32' | 'user'
  hasUninstall: boolean
  displayIcon: string
}

export interface SoftwareReport {
  scannedAt: number
  items: SoftwareItem[]
  totalBytes: number
  userCount: number
}

export type DriverStatus = 'ok' | 'warning' | 'problem'

export interface DriverDevice {
  id: string
  name: string
  className: string
  classLabel: string
  manufacturer: string
  driverVersion: string
  driverDate: string
  driverProvider: string
  infName: string
  signed: boolean | null
  signer: string
  status: DriverStatus
  statusLabel: string
  problemCode: number
  deviceId: string
}

export interface DriverClassSummary {
  className: string
  classLabel: string
  count: number
  attention: number
}

export interface DriverSummary {
  total: number
  attention: number
  problems: number
  unsigned: number
}

export interface DriverReport {
  scannedAt: number
  osName: string
  isAdmin: boolean
  devices: DriverDevice[]
  classes: DriverClassSummary[]
  summary: DriverSummary
}

export interface DriverUpdate {
  id: string
  title: string
  description: string
  driverClass: string
  classLabel: string
  manufacturer: string
  model: string
  driverDate: string
  sizeBytes: number
  downloaded: boolean
  rebootRequired: boolean
}

export interface DriverUpdateCheck {
  checkedAt: number
  updates: DriverUpdate[]
  message: string
}

export interface DriverInstallResult {
  ok: boolean
  message: string
  installed: string[]
  failed: Array<{ title: string; message: string }>
  rebootRequired: boolean
  cancelled: boolean
}

export interface ActionResult {
  ok: boolean
  message: string
}

export type StartupSource =
  | 'user-run'
  | 'machine-run'
  | 'machine-run-32'
  | 'user-startup'
  | 'common-startup'

export interface StartupItem {
  id: string
  name: string
  command: string
  source: StartupSource
  sourceLabel: string
  enabled: boolean
  canToggle: boolean
  impact: 'low' | 'medium' | 'high'
  tip: string
}

export interface StartupReport {
  items: StartupItem[]
  enabledCount: number
  disabledCount: number
  highImpactCount: number
}

export interface StartupToggleResult {
  result: ActionResult
  report: StartupReport
}

export interface StartupOptimizeResult {
  result: ActionResult
  disabled: string[]
  failed: string[]
  report: StartupReport
}

export type ProcessKind = 'system' | 'security' | 'app' | 'background'

export interface SpeedProcess {
  id: string
  name: string
  label: string
  company: string
  path: string
  memoryBytes: number
  cpuPercent: number
  processCount: number
  pids: number[]
  background: boolean
  windowTitle: string
  kind: ProcessKind
  canEnd: boolean
  recommended: boolean
  note: string
}

export interface ProcessReport {
  sampledAt: number
  processes: SpeedProcess[]
  processCount: number
  memoryTotal: number
  memoryUsed: number
  memoryPercent: number
  recommendedCount: number
  recommendedBytes: number
}

export interface EndProcessResult {
  result: ActionResult
  ended: string[]
  failed: Array<{ name: string; message: string }>
  report: ProcessReport
}

export interface NetworkAdapterInfo {
  name: string
  description: string
  status: string
  speedLabel: string
  ipv4: string[]
  dns: string[]
  gateway: string[]
}

export type NetworkPingKind = 'gateway' | 'dns' | 'internet'

export interface NetworkPing {
  target: string
  label: string
  kind: NetworkPingKind
  latencyMs: number | null
}

export interface NetworkStatus {
  capturedAt: number
  adapters: NetworkAdapterInfo[]
  dnsServers: string[]
  proxyEnabled: boolean
  proxyServer: string
  hostsEntries: number
  pings: NetworkPing[]
  isAdmin: boolean
}

export interface NetworkOptimizeInput {
  flushDns: boolean
  resetProxy: boolean
  optimizeTcp: boolean
  resetWinsock: boolean
}

export interface OptimizeStep {
  id: string
  label: string
  ok: boolean
  message: string
  requiresAdmin: boolean
  risky: boolean
}

export interface NetworkOptimizeResult {
  result: ActionResult
  steps: OptimizeStep[]
  rebootRequired: boolean
  status: NetworkStatus
}

export interface PowerPlan {
  guid: string
  name: string
  active: boolean
}

export type VisualEffectsMode = 'performance' | 'balanced' | 'appearance'

export interface PerformanceStatus {
  capturedAt: number
  plans: PowerPlan[]
  activePlan: string
  visualEffects: number
  visualEffectsLabel: string
  visualEffectsMode: VisualEffectsMode | 'custom'
  memoryUsed: number
  memoryTotal: number
  memoryPercent: number
  processCount: number
  uptimeSec: number
  isAdmin: boolean
}

export interface PerformanceOptimizeInput {
  planGuid?: string
  visualEffects?: VisualEffectsMode
}

export interface PerformanceOptimizeResult {
  result: ActionResult
  steps: OptimizeStep[]
  status: PerformanceStatus
}

export type RepairCategory = 'security' | 'network' | 'service' | 'system' | 'shortcut'

export type RepairSeverity = 'high' | 'medium' | 'low'

export type RepairCheckStatus = 'ok' | 'issue' | 'danger' | 'skipped'

export interface RepairCheck {
  id: string
  label: string
  detail: string
  status: RepairCheckStatus
}

export type RepairFixId =
  | 'hosts-reset'
  | 'proxy-reset'
  | 'service-start'
  | 'uac-enable'
  | 'defender-enable'
  | 'firewall-enable'
  | 'ifeo-clean'
  | 'policy-reset'
  | 'shortcut-clean'
  | 'sfc-scan'

export interface RepairIssue {
  id: string
  category: RepairCategory
  title: string
  detail: string
  severity: RepairSeverity
  metric: string
  evidence: string[]
  fixId: RepairFixId | null
  fixLabel: string | null
  fixTarget: string | null
  requiresAdmin: boolean
  risky: boolean
  needsReboot: boolean
  note: string
  page: PageId | null
}

export type RiskEventKind = 'process-end' | 'network-change' | 'system-repair'

export interface RiskEvent {
  id: string
  at: number
  kind: RiskEventKind
  title: string
  detail: string
  severity: RepairSeverity
}

export interface RepairReport {
  scannedAt: number
  isAdmin: boolean
  score: number
  checks: RepairCheck[]
  issues: RepairIssue[]
  riskEvents: RiskEvent[]
}

export interface RepairFixResult {
  result: ActionResult
  fixed: string[]
  failed: Array<{ id: string; title: string; message: string }>
  rebootRequired: boolean
  report: RepairReport
}

export type ScanMode = 'quick' | 'full' | 'custom'

export interface VirusScanOptions {
  mode: ScanMode
  target?: string
}

export type ThreatCategory = 'trojan' | 'malware' | 'riskware' | 'test'

export interface ThreatItem {
  id: string
  path: string
  name: string
  category: ThreatCategory
  severity: 'high' | 'medium' | 'low'
  kind: 'signature' | 'heuristic' | 'test'
  description: string
  size: number
  modifiedAt: number
  sha256?: string
}

export interface ScanProgress {
  running: boolean
  mode: ScanMode | null
  phase: 'preparing' | 'scanning' | 'finalizing' | 'done' | 'cancelled'
  percent: number
  filesScanned: number
  filesTotal: number
  currentPath: string
  threatsFound: number
  elapsedMs: number
  bytesScanned: number
}

export interface ScanSummary {
  id: string
  mode: ScanMode
  target: string
  startedAt: number
  finishedAt: number
  scannedFiles: number
  skippedFiles: number
  threats: ThreatItem[]
  cancelled: boolean
}

export interface ScanState {
  active: boolean
  progress: ScanProgress | null
  last: ScanSummary | null
}

export interface ScanHistoryItem {
  id: string
  mode: ScanMode
  target: string
  completedAt: number
  scannedFiles: number
  threats: number
  durationMs: number
  cancelled: boolean
}

export interface QuarantineItem {
  id: string
  threatName: string
  originalPath: string
  size: number
  quarantinedAt: number
}

export interface QuarantineResult {
  quarantined: number
  failed: Array<{ path: string; error: string }>
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  dataDir: string
  packaged: boolean
}

export type AiProvider = 'ruodao' | 'custom'

export type AiCredential = 'account' | 'apiKey'

export interface AiConfig {
  provider: AiProvider
  credential: AiCredential
  baseUrl: string
  model: string
  shareContext: boolean
  hasApiKey: boolean
  updatedAt: number | null
}

export interface AiConfigInput {
  provider: AiProvider
  credential: AiCredential
  baseUrl: string
  model: string
  shareContext: boolean
  apiKey?: string
  clearApiKey?: boolean
}

export interface RuodaoAccountProfile {
  id: string
  email: string
  displayName: string
}

export interface RuodaoModelOption {
  id: string
  label: string
}

export interface RuodaoAccountState {
  loggedIn: boolean
  profile: RuodaoAccountProfile | null
  expiresAt: number | null
  models: RuodaoModelOption[]
  modelsUpdatedAt: number | null
  modelsError?: string | null
}

export interface RuodaoLoginInput {
  email: string
  password: string
}

export interface AiConnectionResult {
  ok: boolean
  latencyMs: number
  message: string
}

export interface AiChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiChatRequest {
  requestId: string
  messages: AiChatMessage[]
}

export interface AiChatUsage {
  promptTokens?: number
  completionTokens?: number
}

export interface AiChatResult {
  content: string
  model: string
  cancelled: boolean
  usage?: AiChatUsage
}

export interface AiStreamEvent {
  requestId: string
  delta: string
}

export interface GuardApi {
  platform: string
  window: {
    minimize: () => void
    toggleMaximize: () => Promise<boolean>
    isMaximized: () => Promise<boolean>
    close: () => void
    onMaximizeChange: (cb: (maximized: boolean) => void) => () => void
  }
  app: {
    info: () => Promise<AppInfo>
    openDataDir: () => Promise<void>
    openExternal: (url: string) => Promise<void>
    relaunchAsAdmin: () => Promise<ActionResult>
  }
  system: {
    snapshot: () => Promise<SystemSnapshot>
  }
  health: {
    run: () => Promise<HealthReport>
    last: () => Promise<HealthReport | null>
    onProgress: (cb: (progress: HealthProgress) => void) => () => void
  }
  junk: {
    scan: () => Promise<JunkReport>
    last: () => Promise<JunkReport | null>
    clean: (ids: JunkCategoryId[]) => Promise<CleanResult>
  }
  software: {
    list: (force?: boolean) => Promise<SoftwareReport>
    uninstall: (id: string) => Promise<ActionResult>
    openLocation: (id: string) => Promise<ActionResult>
  }
  drivers: {
    scan: (force?: boolean) => Promise<DriverReport>
    checkUpdates: (force?: boolean) => Promise<DriverUpdateCheck>
    lastUpdateCheck: () => Promise<DriverUpdateCheck | null>
    installUpdates: (ids: string[]) => Promise<DriverInstallResult>
    chooseInf: () => Promise<string | null>
    installInf: (infPath: string) => Promise<DriverInstallResult>
    openDeviceManager: () => Promise<ActionResult>
  }
  startup: {
    list: (force?: boolean) => Promise<StartupReport>
    setEnabled: (id: string, enabled: boolean) => Promise<StartupToggleResult>
    optimize: () => Promise<StartupOptimizeResult>
  }
  speed: {
    processes: (force?: boolean) => Promise<ProcessReport>
    endProcesses: (pids: number[]) => Promise<EndProcessResult>
    network: (force?: boolean) => Promise<NetworkStatus>
    optimizeNetwork: (input: NetworkOptimizeInput) => Promise<NetworkOptimizeResult>
    performance: (force?: boolean) => Promise<PerformanceStatus>
    optimizePerformance: (input: PerformanceOptimizeInput) => Promise<PerformanceOptimizeResult>
  }
  repair: {
    scan: (force?: boolean) => Promise<RepairReport>
    last: () => Promise<RepairReport | null>
    fix: (issueIds: string[]) => Promise<RepairFixResult>
    riskLog: (limit?: number) => Promise<RiskEvent[]>
  }
  virus: {
    scan: (options: VirusScanOptions) => Promise<ScanSummary>
    cancel: () => Promise<void>
    state: () => Promise<ScanState>
    onProgress: (cb: (progress: ScanProgress) => void) => () => void
    quarantine: (threatIds: string[]) => Promise<QuarantineResult>
    quarantineList: () => Promise<QuarantineItem[]>
    restore: (ids: string[]) => Promise<ActionResult>
    deleteQuarantine: (ids: string[]) => Promise<ActionResult>
    history: () => Promise<ScanHistoryItem[]>
    createTestSample: () => Promise<ActionResult & { path?: string }>
    chooseFolder: () => Promise<string | null>
  }
  ai: {
    getConfig: () => Promise<AiConfig>
    saveConfig: (input: AiConfigInput) => Promise<AiConfig>
    testConnection: (input: AiConfigInput) => Promise<AiConnectionResult>
    chat: (request: AiChatRequest) => Promise<AiChatResult>
    cancel: (requestId: string) => Promise<void>
    onChunk: (cb: (event: AiStreamEvent) => void) => () => void
    getAccount: () => Promise<RuodaoAccountState>
    login: (input: RuodaoLoginInput) => Promise<RuodaoAccountState>
    logout: () => Promise<RuodaoAccountState>
    refreshModels: () => Promise<RuodaoAccountState>
  }
}
