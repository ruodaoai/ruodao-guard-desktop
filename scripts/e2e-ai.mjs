import http from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'test-artifacts', 'ai')
const chatStorageKey = 'ruodao.ai.chat.v1'
const testKey = 'test-key-e2e'
const mockModel = 'mock-secure-1'
const results = []
const errors = []

let appRef = null
let serverRef = null
let configPath = null
let originalConfig = null
let originalChat = null
let pageRef = null

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function log(message) {
  console.log(message)
}

function mockReplyText() {
  return [
    '这是来自本地模拟模型的安全建议。',
    '',
    '**先做三件事：**',
    '',
    '1. 打开首页体检，查看评分和风险项。',
    '2. 在木马查杀中执行一次快速扫描。',
    '3. 检查开机启动项，不熟悉的项目先保留。',
    '',
    '> 如需清理，请在对应页面确认后再操作。'
  ].join('\n')
}

async function startMockServer() {
  const requests = []
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/stats') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ requests }))
      return
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    let raw = ''
    for await (const chunk of request) raw += chunk
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      body = {}
    }
    const auth = request.headers.authorization || ''
    if (auth !== `Bearer ${testKey}`) {
      requests.push({ kind: 'unauthorized', auth, model: body.model, stream: body.stream === true })
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      return
    }

    const messages = Array.isArray(body.messages)
      ? body.messages.map((message) => ({
          role: message && message.role,
          content: typeof message?.content === 'string' ? message.content.slice(0, 800) : ''
        }))
      : []
    requests.push({
      kind: body.stream === true ? 'chat' : 'test',
      auth,
      model: body.model,
      stream: body.stream === true,
      messages
    })

    if (body.stream !== true) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'mock-test',
          object: 'chat.completion',
          model: body.model || mockModel,
          choices: [{ index: 0, message: { role: 'assistant', content: '连接成功' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 4 }
        })
      )
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    let closed = false
    response.on('close', () => {
      closed = true
    })

    const text = mockReplyText()
    const chunks = []
    for (let index = 0; index < text.length; index += 4) chunks.push(text.slice(index, index + 4))
    let chunkIndex = 0
    response.write(
      `data: ${JSON.stringify({
        model: body.model || mockModel,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' } }]
      })}\n\n`
    )
    const timer = setInterval(() => {
      if (closed) {
        clearInterval(timer)
        return
      }
      if (chunkIndex >= chunks.length) {
        clearInterval(timer)
        response.write(
          `data: ${JSON.stringify({
            model: body.model || mockModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 64, completion_tokens: chunks.length }
          })}\n\n`
        )
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      response.write(
        `data: ${JSON.stringify({
          model: body.model || mockModel,
          choices: [{ index: 0, delta: { content: chunks[chunkIndex] } }]
        })}\n\n`
      )
      chunkIndex++
    }, 55)
  })

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  serverRef = server
  return port
}

async function main() {
  await mkdir(artifacts, { recursive: true })
  const port = await startMockServer()
  const baseUrl = `http://127.0.0.1:${port}/v1`

  const packagedExe = process.env.E2E_EXECUTABLE
  const electronApp = await electron.launch({
    executablePath: packagedExe
      ? path.resolve(root, packagedExe)
      : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: packagedExe ? [] : ['.'],
    cwd: root
  })
  appRef = electronApp

  const page = await electronApp.firstWindow()
  pageRef = page
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  await page.waitForSelector('.titlebar', { timeout: 15000 })
  await page.waitForTimeout(1200)

  const dataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  configPath = path.join(dataDir, 'ai-config.json')
  try {
    originalConfig = await readFile(configPath)
  } catch {
    originalConfig = null
  }
  originalChat = await page.evaluate((key) => window.localStorage.getItem(key), chatStorageKey).catch(() => null)

  async function shot(name) {
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) })
    log(`[shot] ${name}`)
  }

  async function navigate(label) {
    await page.locator('.nav-item').filter({ hasText: label }).first().click()
    await page.waitForTimeout(500)
  }

  await page.evaluate((key) => window.localStorage.removeItem(key), chatStorageKey)

  await navigate('设置中心')
  await page.waitForSelector('.ai-config-card .ai-provider-group', { timeout: 20000 })
  results.push({ page: 'settings', title: await page.locator('.page-title').innerText() })

  await page.locator('.ai-provider-option').filter({ hasText: '自定义服务' }).click()
  await page.locator('#ai-base-url').fill(baseUrl)
  await page.locator('#ai-model').fill(mockModel)
  await page.locator('#ai-api-key').fill('wrong-key')

  await page.getByRole('button', { name: '测试连接' }).click()
  await page.waitForSelector('.ai-test-result.is-error', { timeout: 20000 })
  const authError = await page.locator('.ai-test-result.is-error').innerText()
  log(`[check] wrong key rejected: ${authError.replace(/\s+/g, ' ')}`)
  assert(authError.includes('鉴权失败'), `expected auth error, got: ${authError}`)

  await page.locator('#ai-api-key').fill(testKey)
  await page.getByRole('button', { name: '测试连接' }).click()
  await page.waitForSelector('.ai-test-result.is-ok', { timeout: 20000 })
  const okText = await page.locator('.ai-test-result.is-ok').innerText()
  log(`[check] mock connection: ${okText.replace(/\s+/g, ' ')}`)
  assert(okText.includes('连接成功'), `expected successful connection, got: ${okText}`)
  await shot('01-ai-settings')

  await page.getByRole('button', { name: '保存配置' }).click()
  await page.waitForSelector('.toast-success', { timeout: 10000 })
  const toastText = await page.locator('.toast-success').first().innerText()
  assert(toastText.includes('模型配置已保存'), `unexpected toast: ${toastText}`)

  const storedRaw = await readFile(configPath, 'utf8')
  const stored = JSON.parse(storedRaw)
  assert(stored.provider === 'custom', 'provider was not persisted')
  assert(stored.baseUrl === baseUrl, 'baseUrl was not persisted')
  assert(stored.model === mockModel, 'model was not persisted')
  assert(typeof stored.encryptedApiKey === 'string' && stored.encryptedApiKey.length > 20, 'api key was not encrypted')
  assert(!storedRaw.includes(testKey), 'plaintext api key found on disk')
  log('[check] API key stored encrypted, plaintext absent from ai-config.json')

  const domContent = await page.content()
  assert(!domContent.includes(testKey), 'api key leaked into rendered DOM')
  log('[check] API key absent from rendered document')

  await navigate('AI 安全助手')
  await page.waitForSelector('.chat-welcome', { timeout: 15000 })
  results.push({ page: 'assistant', title: await page.locator('.page-title').innerText() })
  await shot('02-assistant-welcome')

  const composer = page.locator('.chat-input-shell textarea')
  await composer.fill('我的电脑最近很卡，请给出排查步骤。')
  await composer.press('Enter')
  await page.waitForSelector('.chat-msg-user .chat-bubble', { timeout: 10000 })
  await page.waitForSelector('.chat-stop', { timeout: 10000 })
  await page.waitForTimeout(300)
  await shot('03-assistant-streaming')

  const userText = await page.locator('.chat-msg-user .chat-bubble').last().innerText()
  assert(userText.includes('电脑最近很卡'), 'user message missing from chat')

  await page.locator('.chat-msg-foot').filter({ hasText: `由 ${mockModel} 生成` }).last().waitFor({ timeout: 25000 })
  const answer = await page.locator('.chat-msg-assistant .chat-bubble').last().innerText()
  assert(answer.includes('本地模拟模型'), `assistant answer missing: ${answer.slice(0, 80)}`)
  assert(answer.includes('首页体检'), 'assistant answer missing markdown content')
  log('[check] streamed answer completed with model label')
  await shot('04-assistant-answer')

  await composer.fill('请列出更多排查步骤，用于测试停止生成。')
  await composer.press('Enter')
  await page.waitForSelector('.chat-stop', { timeout: 10000 })
  await page.waitForTimeout(420)
  await page.getByRole('button', { name: '停止' }).click()
  await page.locator('.chat-msg-foot').filter({ hasText: '已停止生成' }).last().waitFor({ timeout: 15000 })
  log('[check] streaming cancelled and partial answer kept')
  await shot('05-assistant-stopped')

  const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json()
  const unauthorized = stats.requests.filter((item) => item.kind === 'unauthorized')
  const tests = stats.requests.filter((item) => item.kind === 'test')
  const chats = stats.requests.filter((item) => item.kind === 'chat')
  assert(unauthorized.length >= 1, 'mock server never saw the rejected key test')
  assert(tests.length >= 1, 'mock server never saw test connection request')
  assert(chats.length >= 2, `expected at least 2 chat requests, got ${chats.length}`)
  const lastChat = chats[chats.length - 1]
  assert(lastChat.auth === `Bearer ${testKey}`, 'chat request did not carry expected bearer token')
  assert(lastChat.model === mockModel, 'chat request used unexpected model')
  const system = lastChat.messages.find((message) => message.role === 'system')
  assert(system && system.content.includes('若道安全卫士'), 'system prompt missing from chat request')
  assert(system.content.includes('[本机安全摘要]'), 'sanitized local context missing from chat request')
  log('[check] chat requests carry bearer token, model and sanitized local context')
  results.push({
    mockRequests: { unauthorized: unauthorized.length, test: tests.length, chat: chats.length }
  })

  await navigate('首页体检')
  await navigate('AI 安全助手')
  await page.waitForSelector('.chat-messages', { timeout: 15000 })
  const persisted = await page.locator('.chat-msg-user .chat-bubble').last().innerText()
  assert(persisted.includes('测试停止生成'), 'chat history was not restored after navigation')
  log('[check] chat history restored from local storage')

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1080, 700)
  })
  await page.waitForTimeout(700)
  const gridColumns = await page
    .locator('.assistant-grid')
    .evaluate((element) => window.getComputedStyle(element).gridTemplateColumns)
  log(`[check] assistant grid at 1080x700: ${gridColumns}`)
  await shot('06-assistant-1080x700')
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1260, 820)
  })
  await page.waitForTimeout(500)

  await navigate('设置中心')
  await page.waitForSelector('.ai-config-card .ai-provider-group', { timeout: 15000 })
  const removeButton = page.getByRole('button', { name: '移除', exact: true })
  if (await removeButton.count()) {
    await removeButton.click()
    await page.getByRole('button', { name: '保存配置' }).click()
    await page.waitForSelector('.toast-success', { timeout: 10000 })
    log('[check] saved removal of test API key before restore')
  }

  console.log('\nRESULTS')
  console.log(JSON.stringify({ results, errors }, null, 2))

  await restoreState(page)
  await electronApp.close()
  if (serverRef) await new Promise((resolve) => serverRef.close(resolve))

  if (errors.length > 0) {
    process.exitCode = 1
  }
}

async function restoreState(page) {
  try {
    await page.evaluate(
      ({ key, value }) => {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, value)
      },
      { key: chatStorageKey, value: originalChat }
    )
  } catch {
    // page may already be closed
  }

  try {
    if (originalConfig !== null) {
      await writeFile(configPath, originalConfig)
      log('[cleanup] restored previous ai-config.json')
    } else {
      await rm(configPath, { force: true })
      log('[cleanup] removed test ai-config.json')
    }
  } catch (error) {
    console.error('[cleanup] failed to restore ai-config.json:', error.message)
  }

  pageRef = null
}

main().catch(async (error) => {
  console.error('E2E FAILED:', error)
  if (pageRef) await restoreState(pageRef).catch(() => undefined)
  if (appRef) await appRef.close().catch(() => undefined)
  if (serverRef) await new Promise((resolve) => serverRef.close(resolve))
  process.exitCode = 1
})
