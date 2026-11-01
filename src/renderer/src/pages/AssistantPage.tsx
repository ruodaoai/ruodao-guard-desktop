import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Lock,
  PlugZap,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2
} from 'lucide-react'
import type { AiChatMessage, AiConfig, PageId } from '@shared/types'
import { Button, Card, Chip, ConfirmDialog } from '../components/ui'
import { useToast } from '../components/Toast'
import { aiProviderLabel, cx, errorMessage } from '../lib/format'

const STORAGE_KEY = 'ruodao.ai.chat.v1'
const MAX_STORED_MESSAGES = 60
const MAX_CONTEXT_MESSAGES = 20
const MAX_INPUT = 4000

const QUICK_PROMPTS = [
  {
    title: '电脑变卡',
    text: '电脑最近有点卡，应该先检查哪些地方？'
  },
  {
    title: '软件安全',
    text: '如何判断从网上下载的软件是否安全？'
  },
  {
    title: '可疑链接',
    text: '收到一条可疑短信链接，点开前应该怎么判断？'
  },
  {
    title: '隔离区',
    text: '隔离区和直接删除有什么区别？被隔离的文件该怎么处理？'
  }
]

type MessageStatus = 'streaming' | 'done' | 'error' | 'cancelled'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  error?: string
  model?: string
}

function createId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function loadStoredMessages(): ChatMessage[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const messages: ChatMessage[] = []
    for (const item of parsed.slice(-MAX_STORED_MESSAGES)) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      if (entry.role !== 'user' && entry.role !== 'assistant') continue
      if (typeof entry.content !== 'string' || !entry.content.trim()) continue
      messages.push({
        id: typeof entry.id === 'string' ? entry.id : createId(),
        role: entry.role,
        content: entry.content.slice(0, 16000),
        status: 'done'
      })
    }
    return messages
  } catch {
    return []
  }
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
  let lastIndex = 0
  let index = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code key={`${keyBase}-c${index}`}>{token.slice(1, -1)}</code>)
    } else {
      nodes.push(<strong key={`${keyBase}-b${index}`}>{token.slice(2, -2)}</strong>)
    }
    lastIndex = match.index + token.length
    index++
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function Markdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let blockKey = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (!trimmed) {
      index++
      continue
    }

    const fence = line.match(/^```([\w+-]*)\s*$/)
    if (fence) {
      const code: string[] = []
      index++
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index])
        index++
      }
      if (index < lines.length) index++
      blocks.push(
        <pre className="md-pre" key={blockKey++}>
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      const key = blockKey++
      const content = renderInline(heading[2], `h${key}`)
      blocks.push(
        heading[1].length <= 2 ? (
          <h3 key={key}>{content}</h3>
        ) : (
          <h4 key={key}>{content}</h4>
        )
      )
      index++
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''))
        index++
      }
      const key = blockKey++
      blocks.push(
        <ul key={key}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `ul${key}-${itemIndex}`)}</li>
          ))}
        </ul>
      )
      continue
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''))
        index++
      }
      const key = blockKey++
      blocks.push(
        <ol key={key}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `ol${key}-${itemIndex}`)}</li>
          ))}
        </ol>
      )
      continue
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = []
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''))
        index++
      }
      const key = blockKey++
      blocks.push(<blockquote key={key}>{renderInline(quote.join(' '), `q${key}`)}</blockquote>)
      continue
    }

    const paragraph: string[] = [trimmed]
    index++
    while (index < lines.length) {
      const next = lines[index].trim()
      if (
        !next ||
        next.startsWith('```') ||
        /^(#{1,4})\s+/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+[.)]\s+/.test(next) ||
        next.startsWith('>')
      ) {
        break
      }
      paragraph.push(next)
      index++
    }
    const key = blockKey++
    blocks.push(<p key={key}>{renderInline(paragraph.join(' '), `p${key}`)}</p>)
  }

  return <div className="md">{blocks}</div>
}

function TypingDots(): React.JSX.Element {
  return (
    <span className="typing-dots" aria-label="正在生成回答">
      <i />
      <i />
      <i />
    </span>
  )
}

export function AssistantPage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(loadStoredMessages)
  const [input, setInput] = useState('')
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const stickRef = useRef(true)
  const activeRequestRef = useRef<string | null>(null)
  const activeAssistantRef = useRef<string | null>(null)
  const chunkBufferRef = useRef('')
  const frameRef = useRef<number | null>(null)

  const configured = Boolean(config?.hasApiKey && config.model.trim())
  const busy = busyRequestId !== null

  const loadConfig = useCallback(async (): Promise<void> => {
    setConfigLoading(true)
    setConfigError(null)
    try {
      setConfig(await api.ai.getConfig())
    } catch (loadError) {
      setConfigError(errorMessage(loadError))
    } finally {
      setConfigLoading(false)
    }
  }, [api])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    const unsubscribe = api.ai.onChunk((event) => {
      if (event.requestId !== activeRequestRef.current) return
      chunkBufferRef.current += event.delta
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        const chunk = chunkBufferRef.current
        chunkBufferRef.current = ''
        const targetId = activeAssistantRef.current
        if (!chunk || !targetId) return
        setMessages((previous) =>
          previous.map((message) =>
            message.id === targetId ? { ...message, content: message.content + chunk } : message
          )
        )
      })
    })
    return () => {
      unsubscribe()
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    }
  }, [api])

  useEffect(() => {
    return () => {
      const requestId = activeRequestRef.current
      if (requestId) void api.ai.cancel(requestId).catch(() => undefined)
    }
  }, [api])

  useEffect(() => {
    if (messages.some((message) => message.status === 'streaming')) return
    const stored = messages
      .filter((message) => message.content.trim() && (message.status === 'done' || message.status === 'cancelled'))
      .slice(-MAX_STORED_MESSAGES)
      .map((message) => ({ id: message.id, role: message.role, content: message.content }))
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    } catch {
      // 本地存储不可用时仍保留当前会话
    }
  }, [messages])

  useEffect(() => {
    if (!stickRef.current) return
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages, busyRequestId])

  useEffect(() => {
    const element = inputRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`
  }, [input])

  useEffect(() => {
    if (configured) inputRef.current?.focus()
  }, [configured])

  const scrollToBottom = (): void => {
    stickRef.current = true
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (!element) return
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96
  }

  const send = async (raw?: string): Promise<void> => {
    const text = (raw ?? input).trim()
    if (!text || busy) return
    if (!configured) {
      toast.push('info', '请先在设置中心完成模型配置')
      onNavigate('settings')
      return
    }
    if (text.length > MAX_INPUT) {
      toast.push('error', `单条消息请控制在 ${MAX_INPUT} 字以内`)
      return
    }

    const requestId = createId()
    const assistantId = createId()
    const history: AiChatMessage[] = messages
      .filter((message) => message.content.trim() && message.status !== 'error')
      .slice(-MAX_CONTEXT_MESSAGES)
      .map((message) => ({ role: message.role, content: message.content }))
    history.push({ role: 'user', content: text })

    setMessages((previous) => [
      ...previous,
      { id: createId(), role: 'user', content: text, status: 'done' },
      { id: assistantId, role: 'assistant', content: '', status: 'streaming' }
    ])
    setInput('')
    scrollToBottom()
    activeRequestRef.current = requestId
    activeAssistantRef.current = assistantId
    chunkBufferRef.current = ''
    setBusyRequestId(requestId)

    try {
      const result = await api.ai.chat({ requestId, messages: history })
      setMessages((previous) =>
        previous.map((message) => {
          if (message.id !== assistantId) return message
          return {
            ...message,
            content: result.content || message.content,
            status: result.cancelled ? 'cancelled' : 'done',
            model: result.model
          }
        })
      )
      if (result.cancelled) toast.push('info', '已停止生成')
    } catch (chatError) {
      const message = errorMessage(chatError)
      setMessages((previous) =>
        previous.map((entry) => (entry.id === assistantId ? { ...entry, status: 'error', error: message } : entry))
      )
      toast.push('error', message)
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null
        activeAssistantRef.current = null
        chunkBufferRef.current = ''
        setBusyRequestId(null)
      }
    }
  }

  const stop = async (): Promise<void> => {
    const requestId = activeRequestRef.current
    if (!requestId) return
    setStopping(true)
    try {
      await api.ai.cancel(requestId)
    } catch (stopError) {
      toast.push('error', errorMessage(stopError))
    } finally {
      setStopping(false)
    }
  }

  const clearChat = (): void => {
    setMessages([])
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // 忽略本地存储异常
    }
    setConfirmClear(false)
    toast.push('success', '对话已清空')
  }

  const modelLabel = config?.model || '未选择模型'
  const topbarStatus = configLoading
    ? { tone: 'gray' as const, label: '读取配置中' }
    : !configured
      ? { tone: 'amber' as const, label: '待配置模型' }
      : config?.shareContext
        ? { tone: 'green' as const, label: '已共享脱敏摘要' }
        : { tone: 'gray' as const, label: '未共享本机摘要' }

  return (
    <div className="page assistant-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">AI 安全助手</h1>
          <p className="page-subtitle">结合本机体检摘要，解读风险并给出可执行的处置建议</p>
        </div>
        <div className="page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<Settings2 size={15} />}
            onClick={() => onNavigate('settings')}
          >
            模型设置
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={15} />}
            onClick={() => setConfirmClear(true)}
            disabled={messages.length === 0 || busy}
          >
            清空对话
          </Button>
        </div>
      </div>

      <div className="assistant-grid">
        <Card className="assistant-chat-card">
          <div className="chat-topbar">
            <div className="chat-identity">
              <span className="chat-identity-avatar">
                <Bot size={17} />
              </span>
              <div>
                <b>安全助手</b>
                <span>
                  {configLoading
                    ? '正在读取模型配置…'
                    : config
                      ? `${aiProviderLabel(config.provider)} · ${modelLabel}`
                      : '模型未配置'}
                </span>
              </div>
            </div>
            <div className="chat-topbar-meta">
              <Chip tone={topbarStatus.tone}>{topbarStatus.label}</Chip>
            </div>
          </div>

          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={handleScroll}
            role="log"
            aria-label="与安全助手的对话"
          >
            {configLoading ? (
              <div className="chat-loading">
                <RefreshCw size={18} className="spin" />
                正在读取模型配置…
              </div>
            ) : configError && !config ? (
              <div className="chat-gate">
                <div className="chat-gate-icon is-error">
                  <AlertCircle size={24} />
                </div>
                <h2>无法读取模型配置</h2>
                <p>{configError}</p>
                <div className="chat-gate-actions">
                  <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void loadConfig()}>
                    重新读取
                  </Button>
                </div>
              </div>
            ) : !configured ? (
              <div className="chat-gate">
                <div className="chat-gate-icon">
                  <Sparkles size={25} />
                </div>
                <h2>连接模型，开启 AI 安全助手</h2>
                <p>
                  支持若道云模型与任意 OpenAI 兼容接口。API Key 仅加密保存在本机，由主进程直接请求模型服务。
                </p>
                <div className="chat-gate-actions">
                  <Button variant="primary" icon={<Settings2 size={15} />} onClick={() => onNavigate('settings')}>
                    去配置模型
                  </Button>
                  <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void loadConfig()}>
                    重新检测
                  </Button>
                </div>
                <div className="chat-gate-privacy">
                  <Lock size={12} />
                  共享的体检摘要已脱敏，可随时在设置中关闭
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="chat-welcome">
                <div className="chat-welcome-orb">
                  <Sparkles size={26} />
                </div>
                <h2>有什么安全问题，尽管问我</h2>
                <p>
                  我可以帮你解读体检结果、分析可疑链接与软件，并梳理排查步骤。回答只作为建议，不会直接改动你的电脑。
                </p>
                <div className="chat-prompts">
                  {QUICK_PROMPTS.map((prompt) => (
                    <button
                      key={prompt.title}
                      type="button"
                      className="chat-prompt"
                      onClick={() => void send(prompt.text)}
                      disabled={busy}
                    >
                      <span className="chat-prompt-title">
                        {prompt.title}
                        <ArrowUpRight size={13} />
                      </span>
                      <span>{prompt.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-messages">
                {messages.map((message) => {
                  const showBubble = message.role === 'user' || Boolean(message.content) || message.status === 'streaming'
                  return (
                    <div
                      key={message.id}
                      className={cx('chat-msg', message.role === 'user' ? 'chat-msg-user' : 'chat-msg-assistant')}
                    >
                      {message.role === 'assistant' ? (
                        <span className="chat-avatar">
                          <Bot size={16} />
                        </span>
                      ) : null}
                      <div className="chat-msg-body">
                        {showBubble ? (
                          <div
                            className={cx(
                              'chat-bubble',
                              message.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant'
                            )}
                          >
                            {message.role === 'user' ? (
                              <span className="chat-plain">{message.content}</span>
                            ) : message.content ? (
                              <Markdown text={message.content} />
                            ) : (
                              <TypingDots />
                            )}
                            {message.status === 'streaming' && message.content ? (
                              <span className="typing-cursor" aria-hidden="true" />
                            ) : null}
                          </div>
                        ) : null}
                        {message.status === 'cancelled' ? (
                          <div className="chat-msg-foot">
                            已停止生成{message.content ? '，以上为部分内容' : ''}
                          </div>
                        ) : null}
                        {message.status === 'error' ? (
                          <div className="chat-error">
                            <AlertCircle size={14} />
                            <span>{message.error}</span>
                          </div>
                        ) : null}
                        {message.role === 'assistant' && message.status === 'done' && message.model ? (
                          <div className="chat-msg-foot">由 {message.model.slice(0, 80)} 生成 · 仅供参考</div>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="chat-composer">
            <div className={cx('chat-input-shell', !configured && 'is-disabled')}>
              <textarea
                ref={inputRef}
                value={input}
                rows={1}
                maxLength={MAX_INPUT}
                disabled={!configured}
                placeholder={configured ? '描述你的安全问题，或粘贴可疑信息…' : '请先在设置中心配置模型'}
                aria-label="发送给安全助手的问题"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void send()
                  }
                }}
              />
              <div className="chat-input-bar">
                <span className="chat-input-hint">
                  {busy ? '正在生成回答…' : configured ? 'Enter 发送 · Shift + Enter 换行' : '完成模型配置后即可对话'}
                </span>
                {busy ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="chat-stop"
                    icon={<Square size={11} />}
                    loading={stopping}
                    onClick={() => void stop()}
                  >
                    停止
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    className="chat-send"
                    icon={<ArrowUp size={16} />}
                    disabled={!configured || !input.trim()}
                    onClick={() => void send()}
                    aria-label="发送"
                  />
                )}
              </div>
            </div>
            <p className="chat-disclaimer">
              <ShieldCheck size={12} />
              AI 回答仅供参考，不会直接执行清理、卸载或删除操作
            </p>
          </div>
        </Card>

        <aside className="assistant-rail">
          <Card className="rail-card ai-status-card">
            <div className="rail-title">
              <span className="rail-title-icon">
                <PlugZap size={15} />
              </span>
              <b>模型接入</b>
              <Chip tone={configured ? 'green' : 'amber'}>{configured ? '已配置' : '待配置'}</Chip>
            </div>
            <div className="rail-meta">
              <div>
                <span>服务</span>
                <b>{config ? aiProviderLabel(config.provider) : '读取中'}</b>
              </div>
              <div>
                <span>模型</span>
                <b title={modelLabel}>{modelLabel}</b>
              </div>
              <div>
                <span>密钥</span>
                <b>{config?.hasApiKey ? '已加密保存' : '未填写'}</b>
              </div>
              <div>
                <span>本机摘要</span>
                <b>{config?.shareContext ? '共享（已脱敏）' : '不共享'}</b>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="rail-action"
              icon={<Settings2 size={14} />}
              onClick={() => onNavigate('settings')}
            >
              模型设置
            </Button>
          </Card>

          <Card className="rail-card rail-privacy-card">
            <h3 className="rail-card-title">能力与边界</h3>
            <div className="rail-capability-line">体检解读 · 可疑链接 · 事件处置 · 优化建议</div>
            <div className="rail-note">
              <Lock size={13} />
              <p>对话会发送到你配置的模型服务。共享摘要已去除主机名、文件路径与个人文件内容。</p>
            </div>
            <div className="rail-note">
              <ShieldCheck size={13} />
              <p>助手只提供建议，不会自动执行清理、卸载、禁用启动项或删除文件。</p>
            </div>
            <div className="rail-foot">对话记录仅保存在本机，可随时清空。模型输出仅供参考，重要操作请先备份。</div>
          </Card>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={clearChat}
        title="清空全部对话？"
        confirmText="清空对话"
        tone="danger"
        icon={<Trash2 size={22} />}
      >
        <p>本地保存的对话记录会被删除，此操作无法撤销。</p>
        <p className="modal-note">模型服务端的请求记录不受本操作影响。</p>
      </ConfirmDialog>
    </div>
  )
}
