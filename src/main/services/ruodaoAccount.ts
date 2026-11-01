import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, net, safeStorage } from 'electron'
import type {
  RuodaoAccountProfile,
  RuodaoAccountState,
  RuodaoLoginInput,
  RuodaoModelOption
} from '@shared/types'

const ACCOUNT_FILE = 'ruodao-account.json'
const OFFICIAL_ORIGIN = 'https://ruodao.com'
const LOGIN_TIMEOUT_MS = 20_000
const REFRESH_TIMEOUT_MS = 15_000
const MODELS_TIMEOUT_MS = 20_000
const REFRESH_AHEAD_MS = 3 * 24 * 60 * 60 * 1000
const MAX_MODELS = 200

interface StoredAccount {
  encryptedToken: string
  profile: RuodaoAccountProfile | null
  expiresAt: number
  models: RuodaoModelOption[]
  modelsUpdatedAt: number | null
  updatedAt: number | null
}

type RequestContext = 'login' | 'refresh' | 'models'

class AccountRequestError extends Error {
  readonly auth: boolean
  readonly stale: boolean

  constructor(message: string, auth = false, stale = false) {
    super(message)
    this.name = 'AccountRequestError'
    this.auth = auth
    this.stale = stale
  }
}

let revision = 0
let refreshInFlight: Promise<StoredAccount> | null = null

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function accountOrigin(): string {
  const override = app.isPackaged ? '' : (process.env.RUDAO_ACCOUNT_ORIGIN || '').trim()
  let url: URL
  try {
    url = new URL(override || OFFICIAL_ORIGIN)
  } catch {
    throw new Error('若道账号服务地址配置无效')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('若道账号服务地址配置无效')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new Error('若道账号服务必须使用 HTTPS')
  }
  return url.origin
}

export function ruodaoAiBaseUrl(): string {
  return `${accountOrigin()}/api/v1`
}

function accountPath(dataDir: string): string {
  return path.join(dataDir, ACCOUNT_FILE)
}

function emptyStoredAccount(): StoredAccount {
  return {
    encryptedToken: '',
    profile: null,
    expiresAt: 0,
    models: [],
    modelsUpdatedAt: null,
    updatedAt: null
  }
}

function normalizeProfile(value: unknown, fallbackEmail: string): RuodaoAccountProfile {
  if (!value || typeof value !== 'object') throw new AccountRequestError('若道账号服务返回的用户信息无效')
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id || id.length > 128) throw new AccountRequestError('若道账号服务返回的用户信息无效')
  const email =
    typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim().slice(0, 190) : fallbackEmail
  const displayName =
    typeof raw.displayName === 'string' && raw.displayName.trim()
      ? raw.displayName.trim().slice(0, 80)
      : email.split('@')[0] || '若道用户'
  return { id, email, displayName }
}

function normalizeModels(value: unknown): RuodaoModelOption[] {
  if (!Array.isArray(value)) return []
  const models: RuodaoModelOption[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const id =
      typeof item === 'string'
        ? item.trim()
        : item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string'
          ? ((item as Record<string, unknown>).id as string).trim()
          : ''
    if (!id || id.length > 120 || /[\u0000-\u001f]/.test(id) || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: id })
    if (models.length >= MAX_MODELS) break
  }
  return models
}

function parseStoredAccount(raw: string): StoredAccount {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const profileRaw = parsed.profile
  let profile: RuodaoAccountProfile | null = null
  if (profileRaw && typeof profileRaw === 'object') {
    const entry = profileRaw as Record<string, unknown>
    if (
      typeof entry.id === 'string' &&
      entry.id.trim() &&
      typeof entry.email === 'string' &&
      typeof entry.displayName === 'string'
    ) {
      profile = {
        id: entry.id.trim(),
        email: entry.email.trim(),
        displayName: entry.displayName.trim()
      }
    }
  }
  return {
    encryptedToken: typeof parsed.encryptedToken === 'string' ? parsed.encryptedToken : '',
    profile,
    expiresAt: typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : 0,
    models: normalizeModels(parsed.models),
    modelsUpdatedAt:
      typeof parsed.modelsUpdatedAt === 'number' && Number.isFinite(parsed.modelsUpdatedAt)
        ? parsed.modelsUpdatedAt
        : null,
    updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null
  }
}

async function readStoredAccount(dataDir: string): Promise<StoredAccount> {
  try {
    return parseStoredAccount(await fs.readFile(accountPath(dataDir), 'utf8'))
  } catch {
    return emptyStoredAccount()
  }
}

async function writeStoredAccount(dataDir: string, account: StoredAccount): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(accountPath(dataDir), JSON.stringify(account, null, 2), { mode: 0o600 })
}

async function removeStoredAccount(dataDir: string): Promise<void> {
  try {
    await fs.unlink(accountPath(dataDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new AccountRequestError('当前系统无法安全保存登录状态，暂时不能登录若道账号')
  }
}

function encryptToken(token: string): string {
  requireEncryption()
  return safeStorage.encryptString(token).toString('base64')
}

function decryptToken(encrypted: string): string {
  requireEncryption()
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new AccountRequestError('本机保存的若道登录状态无法解密，请重新登录', true)
  }
}

function publicState(account: StoredAccount, modelsError: string | null = null): RuodaoAccountState {
  const loggedIn = Boolean(account.encryptedToken && account.profile)
  return {
    loggedIn,
    profile: loggedIn ? account.profile : null,
    expiresAt: loggedIn ? account.expiresAt : null,
    models: loggedIn ? account.models : [],
    modelsUpdatedAt: loggedIn ? account.modelsUpdatedAt : null,
    modelsError
  }
}

function loggedOutState(): RuodaoAccountState {
  return {
    loggedIn: false,
    profile: null,
    expiresAt: null,
    models: [],
    modelsUpdatedAt: null,
    modelsError: null
  }
}

function detailFromBody(parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === 'object') {
    const entry = parsed as Record<string, unknown>
    const error = entry.error
    if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
      return ((error as Record<string, unknown>).message as string).replace(/\s+/g, ' ').slice(0, 180)
    }
    if (typeof entry.message === 'string' && entry.message.trim()) {
      return entry.message.replace(/\s+/g, ' ').slice(0, 180)
    }
  }
  return raw.replace(/\s+/g, ' ').slice(0, 180)
}

function isAuthFailure(status: number, detail: string, context: RequestContext): boolean {
  if (context === 'login') return false
  if (status === 401 || status === 403) return true
  if (context === 'refresh') {
    const lower = detail.toLowerCase()
    return (
      lower.includes('account disabled') ||
      lower.includes('token revoked') ||
      lower.includes('account not found') ||
      lower.includes('invalid or expired token')
    )
  }
  return false
}

function friendlyRequestError(status: number, detail: string, context: RequestContext): string {
  const lower = detail.toLowerCase()
  if (context === 'login') {
    if (lower.includes('invalid email or password')) return '邮箱或密码不正确'
    if (lower.includes('account disabled')) return '若道账号已被禁用，请联系若道客服'
    if (lower.includes('account restricted')) return '若道账号暂时受限，请稍后再试'
    if (status === 429) return '登录尝试过于频繁，请稍后再试'
    if (status >= 500) return '若道账号服务暂时不可用，请稍后再试'
    return detail ? `登录失败：${detail}` : '登录失败，请稍后重试'
  }
  if (context === 'refresh') {
    if (
      status === 401 ||
      status === 403 ||
      lower.includes('account disabled') ||
      lower.includes('token revoked') ||
      lower.includes('account not found') ||
      lower.includes('invalid or expired token')
    ) {
      return '若道账号登录已失效，请重新登录'
    }
    if (status === 429) return '请求过于频繁，请稍后再试'
    if (status >= 500) return '若道账号服务暂时不可用，请稍后再试'
    return detail ? `登录状态续期失败：${detail}` : '登录状态续期失败'
  }
  if (status === 401 || status === 403) return '若道账号登录已过期，请重新登录'
  if (status === 429) return '请求过于频繁，请稍后再试'
  if (status >= 500) return '若道模型服务暂时不可用，请稍后再试'
  return detail ? `模型列表读取失败：${detail}` : '模型列表读取失败'
}

async function requestJson(
  path: string,
  options: { method: 'GET' | 'POST'; body?: string; token?: string; timeoutMs: number },
  context: RequestContext
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  let response: Response
  try {
    response = await net.fetch(`${accountOrigin()}${path}`, {
      method: options.method,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      body: options.body,
      signal: controller.signal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AccountRequestError(context === 'login' ? '登录超时，请检查网络后重试' : '连接若道账号服务超时，请稍后重试')
    }
    throw new AccountRequestError('无法连接若道账号服务，请检查网络或代理设置')
  } finally {
    clearTimeout(timer)
  }

  const raw = await response.text().catch(() => '')
  let parsed: unknown = null
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }

  if (!response.ok) {
    const detail = detailFromBody(parsed, raw)
    throw new AccountRequestError(
      friendlyRequestError(response.status, detail, context),
      isAuthFailure(response.status, detail, context)
    )
  }
  if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).success === false) {
    const detail = detailFromBody(parsed, raw)
    throw new AccountRequestError(
      friendlyRequestError(response.status, detail, context),
      isAuthFailure(response.status, detail, context)
    )
  }
  if (parsed === null) {
    throw new AccountRequestError('若道账号服务返回了无法解析的数据，请稍后重试')
  }
  return parsed
}

function readTokenExpiry(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const exp = payload.exp
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null
    return exp * 1000
  } catch {
    return null
  }
}

function normalizeToken(value: unknown): { token: string; expiresAt: number } {
  if (typeof value !== 'string') throw new AccountRequestError('若道账号服务返回的登录凭证无效')
  const token = value.trim()
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw new AccountRequestError('若道账号服务返回的登录凭证无效')
  }
  const expiresAt = readTokenExpiry(token)
  if (!expiresAt) throw new AccountRequestError('若道账号服务返回的登录凭证无效')
  if (expiresAt <= Date.now()) throw new AccountRequestError('若道账号服务返回的登录凭证已过期')
  return { token, expiresAt }
}

function extractAuthData(
  parsed: unknown,
  fallbackEmail: string
): { token: string; expiresAt: number; profile: RuodaoAccountProfile } {
  if (!parsed || typeof parsed !== 'object') throw new AccountRequestError('若道账号服务返回的数据无效')
  const envelope = parsed as Record<string, unknown>
  const data = envelope.data
  if (!data || typeof data !== 'object') throw new AccountRequestError('若道账号服务返回的数据无效')
  const payload = data as Record<string, unknown>
  const normalized = normalizeToken(payload.token)
  return {
    ...normalized,
    profile: normalizeProfile(payload.user, fallbackEmail)
  }
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!email || email.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new AccountRequestError('请输入有效的邮箱地址')
  }
  return email
}

function normalizePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new AccountRequestError('请输入若道账号密码')
  if (value.length > 200) throw new AccountRequestError('密码长度超出限制')
  return value
}

function normalizeLoginInput(value: unknown): RuodaoLoginInput {
  if (!value || typeof value !== 'object') throw new AccountRequestError('登录信息无效')
  const raw = value as Record<string, unknown>
  return { email: normalizeEmail(raw.email), password: normalizePassword(raw.password) }
}

async function fetchModels(token: string): Promise<RuodaoModelOption[]> {
  const parsed = await requestJson(
    '/api/v1/models',
    { method: 'GET', token, timeoutMs: MODELS_TIMEOUT_MS },
    'models'
  )
  if (!parsed || typeof parsed !== 'object') throw new AccountRequestError('模型列表格式异常')
  const payload = parsed as Record<string, unknown>
  let list: unknown = null
  if (Array.isArray(payload.data)) {
    list = payload.data
  } else if (payload.data && typeof payload.data === 'object' && Array.isArray((payload.data as Record<string, unknown>).data)) {
    list = (payload.data as Record<string, unknown>).data
  } else if (Array.isArray(payload.models)) {
    list = payload.models
  }
  if (!Array.isArray(list)) throw new AccountRequestError('模型列表格式异常')
  return normalizeModels(list)
}

async function refreshStoredAccount(dataDir: string, account: StoredAccount): Promise<StoredAccount> {
  const startRevision = revision
  const token = decryptToken(account.encryptedToken)
  const parsed = await requestJson(
    '/api/auth/refresh',
    { method: 'POST', token, timeoutMs: REFRESH_TIMEOUT_MS },
    'refresh'
  )
  if (revision !== startRevision) {
    throw new AccountRequestError('若道账号登录状态已变更，请重试', true, true)
  }
  const auth = extractAuthData(parsed, account.profile?.email || '')
  const next: StoredAccount = {
    ...account,
    encryptedToken: encryptToken(auth.token),
    profile: auth.profile,
    expiresAt: auth.expiresAt,
    updatedAt: Date.now()
  }
  await writeStoredAccount(dataDir, next)
  return next
}

function refreshAccountOnce(dataDir: string, account: StoredAccount): Promise<StoredAccount> {
  if (!refreshInFlight) {
    refreshInFlight = refreshStoredAccount(dataDir, account).finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function clearBrokenAccount(dataDir: string, expectedRevision: number): Promise<void> {
  if (revision !== expectedRevision) return
  revision += 1
  try {
    await removeStoredAccount(dataDir)
  } catch {
    // 清理失败时保持原文件，下次登录会覆盖
  }
}

export function pickRuodaoModel(models: RuodaoModelOption[], current: string): string {
  if (current && models.some((model) => model.id === current)) return current
  return models[0]?.id || current || ''
}

export async function loginRuodao(dataDir: string, input: unknown): Promise<RuodaoAccountState> {
  const { email, password } = normalizeLoginInput(input)
  requireEncryption()
  const parsed = await requestJson(
    '/api/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      timeoutMs: LOGIN_TIMEOUT_MS
    },
    'login'
  )
  const auth = extractAuthData(parsed, email)
  let models: RuodaoModelOption[] = []
  let modelsError: string | null = null
  try {
    models = await fetchModels(auth.token)
  } catch (error) {
    modelsError = error instanceof Error ? error.message : '模型列表读取失败'
  }
  const account: StoredAccount = {
    encryptedToken: encryptToken(auth.token),
    profile: auth.profile,
    expiresAt: auth.expiresAt,
    models,
    modelsUpdatedAt: modelsError ? null : Date.now(),
    updatedAt: Date.now()
  }
  revision += 1
  if (refreshInFlight) {
    try {
      await refreshInFlight
    } catch {
      // 旧会话续期失败不影响本次登录
    }
  }
  await writeStoredAccount(dataDir, account)
  return publicState(account, modelsError)
}

export async function logoutRuodao(dataDir: string): Promise<RuodaoAccountState> {
  revision += 1
  if (refreshInFlight) {
    try {
      await refreshInFlight
    } catch {
      // 等待旧续期请求结束后再删除登录状态
    }
  }
  await removeStoredAccount(dataDir)
  return loggedOutState()
}

export async function getRuodaoAccountState(dataDir: string): Promise<RuodaoAccountState> {
  const startRevision = revision
  let account = await readStoredAccount(dataDir)
  if (!account.encryptedToken || !account.profile) return loggedOutState()

  let token: string
  try {
    token = decryptToken(account.encryptedToken)
  } catch {
    await clearBrokenAccount(dataDir, startRevision)
    return loggedOutState()
  }

  const expiresAt = readTokenExpiry(token) ?? account.expiresAt
  if (!expiresAt) {
    await clearBrokenAccount(dataDir, startRevision)
    return loggedOutState()
  }
  if (expiresAt <= Date.now()) {
    try {
      account = await refreshAccountOnce(dataDir, account)
    } catch (error) {
      if (error instanceof AccountRequestError && error.auth && !error.stale) {
        await clearBrokenAccount(dataDir, startRevision)
      }
      return loggedOutState()
    }
  } else if (expiresAt - Date.now() <= REFRESH_AHEAD_MS) {
    try {
      account = await refreshAccountOnce(dataDir, account)
    } catch {
      // 临近过期但令牌仍有效，续期失败时继续使用当前会话
    }
  }
  return publicState(account)
}

export async function refreshRuodaoModels(dataDir: string): Promise<RuodaoAccountState> {
  const token = await getRuodaoAccessToken(dataDir)
  const account = await readStoredAccount(dataDir)
  if (!account.encryptedToken || !account.profile) {
    throw new AccountRequestError('请先登录若道账号', true)
  }
  const models = await fetchModels(token)
  const next: StoredAccount = {
    ...account,
    models,
    modelsUpdatedAt: Date.now(),
    updatedAt: Date.now()
  }
  await writeStoredAccount(dataDir, next)
  return publicState(next)
}

export async function getRuodaoAccessToken(dataDir: string): Promise<string> {
  const startRevision = revision
  let account = await readStoredAccount(dataDir)
  if (!account.encryptedToken || !account.profile) {
    throw new AccountRequestError('请先登录若道账号', true)
  }
  let token: string
  try {
    token = decryptToken(account.encryptedToken)
  } catch (error) {
    await clearBrokenAccount(dataDir, startRevision)
    throw error
  }
  const expiresAt = readTokenExpiry(token) ?? account.expiresAt
  if (!expiresAt || expiresAt <= Date.now()) {
    try {
      account = await refreshAccountOnce(dataDir, account)
      return decryptToken(account.encryptedToken)
    } catch (error) {
      if (error instanceof AccountRequestError && error.stale) {
        throw new AccountRequestError('若道账号登录状态已更新，请重试')
      }
      if (error instanceof AccountRequestError && error.auth) {
        await clearBrokenAccount(dataDir, startRevision)
        throw new AccountRequestError('若道账号登录已过期，请重新登录', true)
      }
      throw new AccountRequestError('无法验证若道账号登录状态，请检查网络后重试')
    }
  }
  if (expiresAt - Date.now() <= REFRESH_AHEAD_MS) {
    try {
      account = await refreshAccountOnce(dataDir, account)
      return decryptToken(account.encryptedToken)
    } catch {
      return token
    }
  }
  return token
}
