import { promises as fs } from 'node:fs'
import path from 'node:path'
import { net, safeStorage } from 'electron'
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResult,
  AiChatUsage,
  AiConfig,
  AiConfigInput,
  AiConnectionResult,
  AiCredential,
  AiProvider,
  RuodaoAccountState
} from '@shared/types'
import { getLastHealthReport } from './health'
import { getLastJunkReport } from './junk'
import {
  getRuodaoAccessToken,
  getRuodaoAccountState,
  loginRuodao,
  logoutRuodao,
  pickRuodaoModel,
  refreshRuodaoModels,
  ruodaoAiBaseUrl
} from './ruodaoAccount'
import { getScanState } from './virus'

const CONFIG_FILE = 'ai-config.json'
const DEFAULT_BASE_URL = 'https://ruodao.com/api/v1'
const LEGACY_BASE_URLS = new Set(['https://api.ruodao.com', 'https://api.ruodao.com/v1'])
const CHAT_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 25_000
const MAX_CONTEXT_MESSAGES = 20
const MAX_CONTEXT_CHARS = 24_000

interface StoredAiConfig {
  provider: AiProvider
  credential: AiCredential
  baseUrl: string
  model: string
  shareContext: boolean
  encryptedApiKey: string
  updatedAt: number | null
}

interface RuntimeConfig {
  provider: AiProvider
  credential: AiCredential
  baseUrl: string
  model: string
  shareContext: boolean
  apiKey: string
}

interface ActiveChat {
  controller: AbortController
  cancelled: boolean
}

const activeChats = new Map<string, ActiveChat>()

function defaultStoredConfig(): StoredAiConfig {
  return {
    provider: 'ruodao',
    credential: 'apiKey',
    baseUrl: DEFAULT_BASE_URL,
    model: '',
    shareContext: true,
    encryptedApiKey: '',
    updatedAt: null
  }
}

function normalizeStoredBaseUrl(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BASE_URL
  return LEGACY_BASE_URLS.has(raw.replace(/\/+$/, '')) ? DEFAULT_BASE_URL : raw
}

function configPath(dataDir: string): string {
  return path.join(dataDir, CONFIG_FILE)
}

async function readStoredConfig(dataDir: string): Promise<StoredAiConfig> {
  try {
    const raw = await fs.readFile(configPath(dataDir), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const provider: AiProvider = parsed.provider === 'custom' ? 'custom' : 'ruodao'
    return {
      provider,
      credential: provider === 'ruodao' && parsed.credential === 'account' ? 'account' : 'apiKey',
      baseUrl: normalizeStoredBaseUrl(parsed.baseUrl),
      model: typeof parsed.model === 'string' ? parsed.model : '',
      shareContext: parsed.shareContext !== false,
      encryptedApiKey: typeof parsed.encryptedApiKey === 'string' ? parsed.encryptedApiKey : '',
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null
    }
  } catch {
    return defaultStoredConfig()
  }
}

async function writeStoredConfig(dataDir: string, config: StoredAiConfig): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(configPath(dataDir), JSON.stringify(config, null, 2), { mode: 0o600 })
}

function publicConfig(config: StoredAiConfig): AiConfig {
  return {
    provider: config.provider,
    credential: config.credential,
    baseUrl: config.baseUrl,
    model: config.model,
    shareContext: config.shareContext,
    hasApiKey: Boolean(config.encryptedApiKey),
    updatedAt: config.updatedAt
  }
}

function requireProvider(value: unknown): AiProvider {
  if (value === 'ruodao' || value === 'custom') return value
  throw new Error('未知的模型服务类型')
}

function requireCredential(value: unknown, provider: AiProvider): AiCredential {
  if (value === 'account') {
    if (provider !== 'ruodao') throw new Error('只有若道云服务支持账号登录')
    return 'account'
  }
  return 'apiKey'
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写模型 API 地址')
  const raw = value.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('API 地址格式不正确，请包含 http:// 或 https://')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API 地址只支持 http:// 或 https://')
  }
  if (url.username || url.password) throw new Error('API 地址中不能包含账号密码')
  if (url.search || url.hash) throw new Error('API 地址不能包含查询参数或锚点')
  return raw.replace(/\/+$/, '')
}

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写模型名称')
  const model = value.trim()
  if (model.length > 120 || /[\u0000-\u001f]/.test(model)) throw new Error('模型名称无效')
  return model
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function ensureKeyTransport(baseUrl: string, hasKey: boolean): void {
  if (!hasKey) return
  const url = new URL(baseUrl)
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('为避免 API Key 明文传输，非本机 API 地址必须使用 HTTPS')
  }
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法使用安全密钥存储，暂时不能保存 API Key')
  }
}

function encryptApiKey(apiKey: string): string {
  requireEncryption()
  return safeStorage.encryptString(apiKey).toString('base64')
}

function decryptApiKey(encrypted: string): string {
  requireEncryption()
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new Error('已保存的 API Key 无法解密，请在设置中心重新填写')
  }
}

function normalizeApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function chatEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(normalized)) return normalized
  if (/\/v\d+(?:\.\d+)?$/i.test(normalized)) return `${normalized}/chat/completions`
  return `${normalized}/v1/chat/completions`
}

async function resolveRuntimeConfig(dataDir: string, draft?: AiConfigInput): Promise<RuntimeConfig> {
  const stored = await readStoredConfig(dataDir)
  const provider = draft ? requireProvider(draft.provider) : stored.provider
  const credential = draft ? requireCredential(draft.credential, provider) : stored.credential
  const model = normalizeModel(draft ? draft.model : stored.model)
  const shareContext = draft ? draft.shareContext === true : stored.shareContext

  if (credential === 'account') {
    if (provider !== 'ruodao') throw new Error('只有若道云服务支持账号登录')
    const apiKey = await getRuodaoAccessToken(dataDir)
    return { provider, credential, baseUrl: ruodaoAiBaseUrl(), model, shareContext, apiKey }
  }

  const baseUrl = normalizeBaseUrl(draft ? draft.baseUrl : stored.baseUrl)
  const incomingKey = draft ? normalizeApiKey(draft.apiKey) : ''
  let apiKey = incomingKey
  if (!apiKey && draft?.clearApiKey !== true && stored.encryptedApiKey) {
    apiKey = decryptApiKey(stored.encryptedApiKey)
  }
  if (!apiKey) throw new Error('请先在设置中心填写模型 API Key')
  ensureKeyTransport(baseUrl, true)
  return { provider, credential, baseUrl, model, shareContext, apiKey }
}

export async function getAiConfig(dataDir: string): Promise<AiConfig> {
  return publicConfig(await readStoredConfig(dataDir))
}

export async function saveAiConfig(dataDir: string, input: AiConfigInput): Promise<AiConfig> {
  if (!input || typeof input !== 'object') throw new Error('模型配置无效')
  const provider = requireProvider(input.provider)
  const credential = requireCredential(input.credential, provider)
  const model = normalizeModel(input.model)
  const stored = await readStoredConfig(dataDir)
  let baseUrl: string
  if (credential === 'account') {
    const account = await getRuodaoAccountState(dataDir)
    if (!account.loggedIn) throw new Error('请先登录若道账号')
    if (account.models.length > 0 && !account.models.some((option) => option.id === model)) {
      throw new Error('请选择若道账号可用的模型')
    }
    baseUrl = ruodaoAiBaseUrl()
  } else {
    baseUrl = normalizeBaseUrl(input.baseUrl)
  }
  const incomingKey = normalizeApiKey(input.apiKey)
  let encryptedApiKey = stored.encryptedApiKey
  if (incomingKey) {
    encryptedApiKey = encryptApiKey(incomingKey)
  } else if (input.clearApiKey === true) {
    encryptedApiKey = ''
  }
  ensureKeyTransport(baseUrl, credential === 'apiKey' && Boolean(encryptedApiKey))
  const next: StoredAiConfig = {
    provider,
    credential,
    baseUrl,
    model,
    shareContext: input.shareContext === true,
    encryptedApiKey,
    updatedAt: Date.now()
  }
  await writeStoredConfig(dataDir, next)
  return publicConfig(next)
}

export async function getAiAccount(dataDir: string): Promise<RuodaoAccountState> {
  return getRuodaoAccountState(dataDir)
}

export async function loginAiAccount(dataDir: string, input: unknown): Promise<RuodaoAccountState> {
  const account = await loginRuodao(dataDir, input)
  const stored = await readStoredConfig(dataDir)
  const model =
    account.models.length > 0
      ? pickRuodaoModel(account.models, stored.model)
      : stored.credential === 'account'
        ? stored.model
        : ''
  const next: StoredAiConfig = {
    ...stored,
    provider: 'ruodao',
    credential: 'account',
    baseUrl: ruodaoAiBaseUrl(),
    model,
    updatedAt: Date.now()
  }
  await writeStoredConfig(dataDir, next)
  return account
}

export async function logoutAiAccount(dataDir: string): Promise<RuodaoAccountState> {
  const account = await logoutRuodao(dataDir)
  const stored = await readStoredConfig(dataDir)
  if (stored.credential === 'account') {
    await writeStoredConfig(dataDir, {
      ...stored,
      provider: 'ruodao',
      credential: 'apiKey',
      updatedAt: Date.now()
    })
  }
  return account
}

export async function refreshAiModels(dataDir: string): Promise<RuodaoAccountState> {
  const account = await refreshRuodaoModels(dataDir)
  const stored = await readStoredConfig(dataDir)
  if (stored.credential === 'account' && stored.provider === 'ruodao' && account.models.length > 0) {
    const model = pickRuodaoModel(account.models, stored.model)
    if (model !== stored.model) {
      await writeStoredConfig(dataDir, { ...stored, model, updatedAt: Date.now() })
    }
  }
  return account
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function buildLocalContext(): string {
  const lines: string[] = []
  const health = getLastHealthReport()
  if (health) {
    const snapshot = health.snapshot
    lines.push(`操作系统：${snapshot.osName} ${snapshot.osVersion} ${snapshot.arch}`)
    lines.push(`内存占用：${snapshot.memoryPercent}%（${formatBytes(snapshot.memoryUsed)} / ${formatBytes(snapshot.memoryTotal)}）`)
    const disks = snapshot.disks
      .slice(0, 4)
      .map((disk) => `${disk.id} ${Math.round(((disk.total - disk.free) / Math.max(disk.total, 1)) * 100)}% 已用`)
      .join('；')
    if (disks) lines.push(`磁盘占用：${disks}`)
    lines.push(
      `Windows Defender 实时防护：${!snapshot.defender.available ? '未检测到' : snapshot.defender.realtime ? '已开启' : '未开启'}`
    )
    const issues = health.issues
      .slice(0, 4)
      .map((issue) => issue.title)
      .join('、')
    lines.push(`最近体检：${health.score} / 100 分`, `体检时间：${formatDate(health.checkedAt)}`)
    lines.push(`主要问题：${issues || '未发现明显问题'}`)
    lines.push(`体检时启动项：${health.startupCount} 项启用`)
    lines.push(`体检发现的风险项：${health.threatCount} 个`)
    if (health.lastScanAt) lines.push(`上次木马查杀：${formatDate(health.lastScanAt)}`)
  } else {
    lines.push('最近体检：尚未完成')
  }

  const junk = getLastJunkReport()
  if (junk) {
    lines.push(`最近垃圾扫描：${formatBytes(junk.totalBytes)} / ${junk.totalFiles} 个文件`)
  }

  const scan = getScanState()
  if (scan.last) {
    lines.push(
      `最近查杀结果：${scan.last.cancelled ? '已停止' : scan.last.threats.length > 0 ? `发现 ${scan.last.threats.length} 个风险项` : '未发现风险'}，扫描 ${scan.last.scannedFiles} 个文件`
    )
  }

  lines.push(`当前日期：${formatDate(Date.now()).slice(0, 10)}`)
  return lines.length > 0
    ? `[本机安全摘要]\n${lines.join('\n')}\n以上摘要由本地安全引擎生成，不包含文件名、完整路径或个人文件内容。`
    : ''
}

function systemPrompt(): string {
  const base = [
    '你是「若道安全卫士」内置的 AI 安全助手，面向 Windows 用户提供电脑安全、隐私与系统维护建议。',
    '应用包含七个模块：首页体检、木马查杀、垃圾清理、软件管家、驱动管理、开机加速、设置中心（含隔离区）。',
    '',
    '回答规则：',
    '1. 先给结论，再给清晰、可执行的步骤；使用简体中文，避免夸大或制造恐慌。',
    '2. 你只能分析和建议，不能代替用户执行清理、卸载、禁用启动项、查杀、删除文件或安装驱动。需要执行时，明确告知对应的应用页面和风险，提醒用户二次确认。',
    '3. 不要虚构本机数据或声称已经扫描、检测、清理过任何内容。上下文中没有的信息，直接说明无法读取并建议用户查看对应页面。',
    '4. 不要索取密码、验证码、API Key、身份证号等敏感信息；不要建议关闭杀毒软件、实时防护或绕过系统权限。',
    '5. 对疑似木马、勒索软件或钓鱼事件，优先建议断网、保留证据、使用木马查杀与隔离，并提醒必要时联系专业人员。',
    '6. 涉及注册表、系统文件、批量删除等高风险操作时，先说明风险与回退方式，优先推荐系统自带的安全做法。',
    '7. 驱动问题建议先在驱动管理页查看设备状态与驱动版本；安装驱动需要管理员权限和 UAC 确认，只建议安装 Windows 更新或设备厂商提供的签名驱动，并提醒重启与驱动回退风险。',
    '8. 模型回答仅供参考，涉及重要数据时提醒用户先备份。'
  ]
  return base.join('\n')
}

function buildMessages(history: AiChatMessage[], shareContext: boolean): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const context = shareContext ? buildLocalContext() : ''
  const system = context ? `${systemPrompt()}\n\n${context}` : systemPrompt()
  const selected = history.slice(-MAX_CONTEXT_MESSAGES)
  let budget = MAX_CONTEXT_CHARS
  const kept: AiChatMessage[] = []
  for (let index = selected.length - 1; index >= 0; index--) {
    const message = selected[index]
    const content = message.content.slice(0, 8000)
    if (content.length > budget) break
    budget -= content.length
    kept.unshift({ role: message.role, content })
  }
  return [{ role: 'system', content: system }, ...kept]
}

function normalizeChatRequest(value: unknown): AiChatRequest {
  if (!value || typeof value !== 'object') throw new Error('对话请求无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(raw.requestId)) {
    throw new Error('对话请求标识无效')
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) throw new Error('对话内容不能为空')
  const messages: AiChatMessage[] = []
  for (const item of raw.messages) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (entry.role !== 'user' && entry.role !== 'assistant') continue
    if (typeof entry.content !== 'string') continue
    const content = entry.content.trim()
    if (!content) continue
    messages.push({ role: entry.role, content: content.slice(0, 8000) })
  }
  if (messages.length === 0) throw new Error('对话内容不能为空')
  return { requestId: raw.requestId, messages }
}

function mapUsage(raw: unknown): AiChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, unknown>
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  if (promptTokens === undefined && completionTokens === undefined) return undefined
  return { promptTokens, completionTokens }
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          return (part as Record<string, unknown>).text as string
        }
        return ''
      })
      .join('')
  }
  return ''
}

async function readErrorDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '')
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const error = parsed.error
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string') return message.replace(/\s+/g, ' ').slice(0, 180)
    }
    if (typeof parsed.message === 'string') return parsed.message.replace(/\s+/g, ' ').slice(0, 180)
  } catch {
    return raw.replace(/\s+/g, ' ').slice(0, 180)
  }
  return ''
}

function httpErrorMessage(status: number, detail: string, credential: AiCredential): string {
  if (status === 401 || status === 403) {
    return credential === 'account'
      ? '若道账号登录已失效或没有该模型权限，请重新登录'
      : '鉴权失败，请检查 API Key 是否正确或是否有模型访问权限'
  }
  if (status === 402 && credential === 'account') return '若道账号余额不足，请充值后重试'
  if (status === 404) return '接口或模型不存在，请检查 API 地址和模型名称'
  if (status === 408) return '模型服务响应超时，请稍后重试'
  if (status === 429) return '请求过于频繁或额度不足，请稍后再试'
  if (status >= 500) return `模型服务暂时不可用（HTTP ${status}），请稍后重试`
  return detail ? `模型服务返回错误：${detail}` : `模型服务返回错误（HTTP ${status}）`
}

function networkErrorMessage(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const raw = error instanceof Error ? error.message : String(error)
  if (/ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|INTERNET_DISCONNECTED|CERT|SSL|PROXY)/i.test(raw) || /fetch failed/i.test(raw)) {
    return new Error('无法连接到模型服务，请检查 API 地址、网络或代理设置')
  }
  return new Error(raw || '调用模型服务失败')
}

async function requestCompletion(
  config: RuntimeConfig,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  stream: boolean,
  signal: AbortSignal,
  maxTokens?: number
): Promise<Response> {
  const endpoint = chatEndpoint(config.baseUrl)
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
    temperature: 0.4
  }
  if (maxTokens) body.max_tokens = maxTokens
  let response: Response
  try {
    response = await net.fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (error) {
    throw networkErrorMessage(error)
  }
  if (!response.ok) {
    throw new Error(httpErrorMessage(response.status, await readErrorDetail(response), config.credential))
  }
  return response
}

async function readStreamingResponse(
  response: Response,
  onDelta: (delta: string) => void
): Promise<{ content: string; model?: string; usage?: AiChatUsage }> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    const raw = await response.text()
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error('模型返回格式无法解析，请确认接口兼容 OpenAI Chat Completions')
    }
    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    const choice = choices[0] as Record<string, unknown> | undefined
    const message = choice?.message as Record<string, unknown> | undefined
    const content = extractText(message?.content)
    if (!content) throw new Error('模型未返回内容，请检查模型名称或服务配置')
    onDelta(content)
    return {
      content,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      usage: mapUsage(parsed.usage)
    }
  }

  if (!response.body) throw new Error('模型响应为空，请稍后重试')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let model: string | undefined
  let usage: AiChatUsage | undefined

  const consumeLine = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false
    const payload = trimmed.slice(5).trim()
    if (!payload) return false
    if (payload === '[DONE]') return true
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return false
    }
    if (parsed.error) {
      const error = parsed.error
      const message =
        error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
          ? ((error as Record<string, unknown>).message as string)
          : '模型服务返回错误'
      throw new Error(message)
    }
    if (typeof parsed.model === 'string') model = parsed.model
    const parsedUsage = mapUsage(parsed.usage)
    if (parsedUsage) usage = parsedUsage
    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    const choice = choices[0] as Record<string, unknown> | undefined
    const delta = choice?.delta as Record<string, unknown> | undefined
    const text = extractText(delta?.content)
    if (text) {
      content += text
      onDelta(text)
    }
    return false
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (consumeLine(line)) return { content, model, usage }
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeLine(buffer)
  } finally {
    reader.releaseLock()
  }

  if (!content) throw new Error('模型未返回内容，请检查模型名称或服务配置')
  return { content, model, usage }
}

export async function testAiConnection(dataDir: string, input: AiConfigInput): Promise<AiConnectionResult> {
  const startedAt = Date.now()
  try {
    const config = await resolveRuntimeConfig(dataDir, input)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      const response = await requestCompletion(
        config,
        [{ role: 'user', content: '请只回复：连接成功' }],
        false,
        controller.signal,
        16
      )
      const raw = await response.text()
      let content = ''
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const choices = Array.isArray(parsed.choices) ? parsed.choices : []
        const message = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
        content = extractText(message?.content)
      } catch {
        content = raw
      }
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        message: content.trim() ? `模型已响应：${content.trim().slice(0, 60)}` : '连接成功'
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? '连接超时，请检查 API 地址与网络'
        : error instanceof Error
          ? error.message
          : '连接失败'
    return { ok: false, latencyMs: Date.now() - startedAt, message }
  }
}

export async function chatWithAi(
  dataDir: string,
  request: unknown,
  onDelta: (delta: string) => void
): Promise<AiChatResult> {
  const parsedRequest = normalizeChatRequest(request)
  if (activeChats.has(parsedRequest.requestId)) throw new Error('该对话正在处理中')
  const config = await resolveRuntimeConfig(dataDir)
  const messages = buildMessages(parsedRequest.messages, config.shareContext)
  const entry: ActiveChat = { controller: new AbortController(), cancelled: false }
  activeChats.set(parsedRequest.requestId, entry)

  let timedOut = false
  let content = ''
  const timer = setTimeout(() => {
    timedOut = true
    entry.controller.abort()
  }, CHAT_TIMEOUT_MS)

  try {
    const response = await requestCompletion(config, messages, true, entry.controller.signal)
    const result = await readStreamingResponse(response, (delta) => {
      content += delta
      onDelta(delta)
    })
    return {
      content: result.content,
      model: result.model || config.model,
      cancelled: false,
      usage: result.usage
    }
  } catch (error) {
    if (entry.cancelled) {
      return { content, model: config.model, cancelled: true }
    }
    if (timedOut) throw new Error('模型响应超时，请稍后重试或缩短问题')
    throw error
  } finally {
    clearTimeout(timer)
    activeChats.delete(parsedRequest.requestId)
  }
}

export function cancelAiChat(requestId: string): void {
  const entry = activeChats.get(requestId)
  if (!entry) return
  entry.cancelled = true
  entry.controller.abort()
}
