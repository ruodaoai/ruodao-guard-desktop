import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles
} from 'lucide-react'
import type { AiConfig, AiConfigInput, AiConnectionResult, AiProvider, PageId } from '@shared/types'
import { Button, Card, Chip, Toggle } from './ui'
import { useToast } from './Toast'
import { aiProviderLabel, cx, errorMessage, timeAgo } from '../lib/format'

const DEFAULT_BASE_URL = 'https://api.ruodao.com/v1'

export function AiConfigCard({ onNavigate }: { onNavigate?: (page: PageId) => void }): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [provider, setProvider] = useState<AiProvider>('ruodao')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [model, setModel] = useState('')
  const [shareContext, setShareContext] = useState(true)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AiConnectionResult | null>(null)
  const customBaseRef = useRef('')

  const applyConfig = useCallback((next: AiConfig): void => {
    setConfig(next)
    setProvider(next.provider)
    setBaseUrl(next.baseUrl)
    setModel(next.model)
    setShareContext(next.shareContext)
    setHasStoredKey(next.hasApiKey)
    setApiKey('')
    setShowKey(false)
    setClearKey(false)
    if (next.provider === 'custom') customBaseRef.current = next.baseUrl
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      applyConfig(await api.ai.getConfig())
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [api, applyConfig])

  useEffect(() => {
    void load()
  }, [load])

  const keyAvailable = Boolean(apiKey.trim() || (hasStoredKey && !clearKey))
  const complete = keyAvailable && Boolean(baseUrl.trim()) && Boolean(model.trim())

  const validate = (requireKey: boolean): string | null => {
    if (!baseUrl.trim()) return '请填写 API 地址'
    let url: URL
    try {
      url = new URL(baseUrl.trim())
    } catch {
      return 'API 地址格式不正确，请包含 http:// 或 https://'
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'API 地址只支持 http:// 或 https://'
    if (!model.trim()) return '请填写模型名称'
    if (requireKey && !keyAvailable) return '请先填写 API Key 再测试连接'
    return null
  }

  const buildInput = (): AiConfigInput => ({
    provider,
    credential: 'apiKey',
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    shareContext,
    apiKey: apiKey.trim() || undefined,
    clearApiKey: clearKey || undefined
  })

  const chooseProvider = (next: AiProvider): void => {
    if (next === provider) return
    setTestResult(null)
    if (next === 'ruodao') {
      if (provider === 'custom') customBaseRef.current = baseUrl
      setProvider('ruodao')
      setBaseUrl(DEFAULT_BASE_URL)
    } else {
      setProvider('custom')
      setBaseUrl(customBaseRef.current || '')
    }
  }

  const save = async (): Promise<void> => {
    if (saving) return
    const error = validate(false)
    if (error) {
      toast.push('info', error)
      return
    }
    setSaving(true)
    setTestResult(null)
    try {
      applyConfig(await api.ai.saveConfig(buildInput()))
      toast.push('success', '模型配置已保存')
    } catch (saveError) {
      toast.push('error', errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    if (testing) return
    const error = validate(true)
    if (error) {
      setTestResult({ ok: false, latencyMs: 0, message: error })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.ai.testConnection(buildInput()))
    } catch (testError) {
      setTestResult({ ok: false, latencyMs: 0, message: errorMessage(testError) })
    } finally {
      setTesting(false)
    }
  }

  const removeKey = (): void => {
    setClearKey(true)
    setHasStoredKey(false)
    setApiKey('')
    setTestResult(null)
  }

  const undoRemoveKey = (): void => {
    setClearKey(false)
    setHasStoredKey(config?.hasApiKey === true)
  }

  return (
    <Card className="settings-card ai-config-card">
      <div className="card-head">
        <div>
          <h3>
            <span className="ai-section-icon">
              <Sparkles size={15} />
            </span>
            AI 模型接入
            <Chip tone={complete ? 'green' : 'amber'}>{complete ? '已填写' : '待完善'}</Chip>
          </h3>
          <p>配置若道云或任意 OpenAI 兼容服务，为 AI 安全助手提供对话能力</p>
        </div>
        {onNavigate ? (
          <Button variant="ghost" size="sm" icon={<Sparkles size={14} />} onClick={() => onNavigate('assistant')}>
            打开助手
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="quarantine-loading">
          <Loader2 size={20} className="spin" />
          正在读取模型配置…
        </div>
      ) : loadError ? (
        <div className="ai-config-error">
          <span>{loadError}</span>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>
            重新读取
          </Button>
        </div>
      ) : (
        <div className="ai-config-body">
          <div className="ai-config-main">
            <div className="ai-field">
              <span className="ai-label">服务类型</span>
              <div className="ai-provider-group" role="radiogroup" aria-label="模型服务类型">
                <button
                  type="button"
                  role="radio"
                  aria-checked={provider === 'ruodao'}
                  className={cx('ai-provider-option', provider === 'ruodao' && 'is-active')}
                  onClick={() => chooseProvider('ruodao')}
                >
                  <b>若道云</b>
                  <span>云端模型服务 · 预置默认地址</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={provider === 'custom'}
                  className={cx('ai-provider-option', provider === 'custom' && 'is-active')}
                  onClick={() => chooseProvider('custom')}
                >
                  <b>自定义服务</b>
                  <span>任意 OpenAI 兼容接口</span>
                </button>
              </div>
            </div>

            <div className="ai-field-row">
              <div className="ai-field">
                <label className="ai-label" htmlFor="ai-base-url">
                  API 地址
                </label>
                <input
                  id="ai-base-url"
                  className="ai-input"
                  value={baseUrl}
                  spellCheck={false}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => {
                    setBaseUrl(event.target.value)
                    setTestResult(null)
                  }}
                />
                <div className="ai-hint-row">
                  <span className="ai-hint">可填到 /v1，也可直接填完整的 /chat/completions 地址</span>
                  {provider === 'ruodao' && baseUrl !== DEFAULT_BASE_URL ? (
                    <button type="button" className="ai-text-button" onClick={() => setBaseUrl(DEFAULT_BASE_URL)}>
                      恢复默认
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="ai-field">
                <label className="ai-label" htmlFor="ai-model">
                  模型名称
                </label>
                <input
                  id="ai-model"
                  className="ai-input"
                  value={model}
                  spellCheck={false}
                  placeholder={provider === 'ruodao' ? '填写若道云控制台提供的模型 ID' : '例如 gpt-4o-mini'}
                  onChange={(event) => {
                    setModel(event.target.value)
                    setTestResult(null)
                  }}
                />
                <span className="ai-hint">必须与服务商提供的模型 ID 完全一致</span>
              </div>
            </div>

            <div className="ai-field">
              <label className="ai-label" htmlFor="ai-api-key">
                API Key
              </label>
              <div className="ai-key-row">
                <div className="ai-key-input">
                  <KeyRound size={15} />
                  <input
                    id="ai-api-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={hasStoredKey && !clearKey ? '已保存，留空则保持不变' : '粘贴 API Key'}
                    onChange={(event) => {
                      setApiKey(event.target.value)
                      setClearKey(false)
                      setTestResult(null)
                    }}
                  />
                  <button
                    type="button"
                    className="ai-key-visibility"
                    onClick={() => setShowKey((previous) => !previous)}
                    aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                {hasStoredKey && !clearKey ? (
                  <Button variant="ghost" size="sm" onClick={removeKey}>
                    移除
                  </Button>
                ) : clearKey ? (
                  <Button variant="ghost" size="sm" onClick={undoRemoveKey}>
                    撤销移除
                  </Button>
                ) : null}
              </div>
              <span className="ai-hint">
                {clearKey
                  ? '保存后将移除本机已加密的 API Key。'
                  : '保存后由 Windows 安全存储加密，页面无法再次读取明文。'}
              </span>
            </div>

            <div className="ai-share">
              <Toggle
                checked={shareContext}
                onChange={(next) => {
                  setShareContext(next)
                  setTestResult(null)
                }}
                label="共享脱敏的本机体检摘要"
              />
              <div>
                <b>共享本机体检摘要</b>
                <p>
                  仅发送系统版本、内存与磁盘占用、体检评分、启动项数量与扫描统计；不包含主机名、账号、文件路径和个人文件内容。
                </p>
              </div>
            </div>
          </div>

          <aside className="ai-config-side">
            <div className="ai-side-head">
              <span className={cx('ai-side-dot', complete && 'is-ok')} />
              <b>{complete ? '配置已就绪' : '配置尚未完成'}</b>
            </div>
            <p>
              {complete
                ? '可以先测试连接，保存后回到助手页面开始对话。'
                : '填写 API 地址、模型名称和 API Key 后即可使用。'}
            </p>
            <div className="ai-side-meta">
              <span>当前服务：{aiProviderLabel(provider)}</span>
              <span>API Key：{hasStoredKey && !clearKey ? '已加密保存' : '未保存'}</span>
              {config?.updatedAt ? <span>上次保存：{timeAgo(config.updatedAt)}</span> : <span>尚未保存过配置</span>}
            </div>
            <ul className="ai-config-points">
              <li>模型请求由主进程发出，保存后密钥不回传页面</li>
              <li>非本机 HTTP 地址会被拒绝，避免密钥明文传输</li>
              <li>共享内容在发送前去除主机名与文件路径</li>
            </ul>
            <div className="ai-config-actions">
              <Button variant="primary" size="sm" onClick={() => void save()} loading={saving} disabled={testing}>
                保存配置
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void test()}
                loading={testing}
                disabled={saving || !complete}
              >
                测试连接
              </Button>
            </div>
            {testResult ? (
              <div className={cx('ai-test-result', testResult.ok ? 'is-ok' : 'is-error')}>
                {testResult.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                <div>
                  <b>{testResult.ok ? `连接成功 · ${testResult.latencyMs} ms` : '连接失败'}</b>
                  <p>{testResult.message}</p>
                </div>
              </div>
            ) : null}
            <p className="ai-config-footnote">
              若道云地址为预置入口，实际可用地址与模型请以服务商控制台为准；模型服务产生的费用与数据处理遵循对应服务商规则。
            </p>
          </aside>
        </div>
      )}
    </Card>
  )
}
