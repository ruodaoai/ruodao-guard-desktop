import { mkdir, unlink, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'test-artifacts', 'ui')
const errors = []
const evidence = {}
let appRef = null
let sampleRef = null

function log(message) {
  console.log(message)
}

async function main() {
  await mkdir(artifacts, { recursive: true })

  const electronApp = await electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: root
  })
  appRef = electronApp

  const page = await electronApp.firstWindow()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  async function shot(name) {
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) })
    log(`[shot] ${name}`)
  }

  await page.waitForSelector('.titlebar', { timeout: 15000 })
  await page.locator('.nav-item').filter({ hasText: '木马查杀' }).first().click()
  await page.waitForSelector('.scan-tip-strip', { timeout: 15000 })
  await page.waitForTimeout(600)

  await page.getByRole('button', { name: '生成测试样本' }).click()
  await page.waitForSelector('.modal-panel', { timeout: 5000 })
  await page.getByRole('button', { name: '生成样本', exact: true }).click()
  await page.waitForSelector('.sample-created', { timeout: 15000 })
  const samplePath = await page.locator('.sample-created').getAttribute('title')
  const sampleName = samplePath ? path.basename(samplePath) : ''
  sampleRef = samplePath
  log(`[fixture] demo sample: ${samplePath}`)
  if (!samplePath) throw new Error('sample path missing')

  await page.locator('.sample-created button').click()
  await page.waitForTimeout(600)
  await shot('12-virus-scanning')

  await page.waitForSelector('.result-danger, .result-safe, .result-cancelled', { timeout: 240000 })
  await page.waitForTimeout(400)
  await shot('13-virus-result')
  const resultTitle = (await page.locator('.scan-result h2').innerText()).trim()
  const threatCount = await page.locator('.threat-row').count()
  evidence.scanResult = resultTitle
  evidence.threatCount = threatCount
  log(`[check] scan result: ${resultTitle} / ${threatCount} threat rows`)

  const sampleRow = page.locator('.threat-row').filter({ hasText: sampleName })
  if (!(await sampleRow.count())) {
    throw new Error(`scan did not flag the demo sample ${sampleName}`)
  }
  await sampleRow.getByRole('button', { name: '隔离', exact: true }).click()
  const quarantineToast = page.locator('.toast-success').filter({ hasText: '移入隔离区' }).first()
  await quarantineToast.waitFor({ timeout: 15000 })
  log(`[check] quarantine toast: ${(await quarantineToast.locator('.toast-message').innerText()).trim()}`)
  await page.waitForTimeout(600)
  await shot('14-virus-after-quarantine')

  await page.locator('.nav-item').filter({ hasText: '设置中心' }).first().click()
  await page.waitForSelector('.quarantine-row', { timeout: 20000 })
  await page.waitForTimeout(500)
  const quarantineRows = await page.locator('.quarantine-row').count()
  const quarantineName = (await page.locator('.quarantine-copy b').first().innerText()).trim()
  evidence.quarantineRows = quarantineRows
  evidence.quarantineName = quarantineName
  log(`[check] quarantine rows: ${quarantineRows} (${quarantineName})`)
  await shot('15-quarantine-list')

  await page.locator('.quarantine-row').first().getByRole('button', { name: '恢复', exact: true }).click()
  await page.waitForSelector('.modal-panel', { timeout: 5000 })
  await page.waitForTimeout(350)
  await shot('16-quarantine-restore-confirm')
  await page.getByRole('button', { name: '恢复文件', exact: true }).click()
  await page.waitForSelector('.quarantine-row', { state: 'detached', timeout: 15000 })
  await page.waitForSelector('.quarantine-card .empty-state', { timeout: 15000 })
  log('[check] quarantine restored to empty')
  await shot('17-quarantine-empty')

  await access(samplePath)
  log('[check] restored sample exists on disk')
  await unlink(samplePath)
  log('[cleanup] demo sample removed')

  console.log('\nEVIDENCE')
  console.log(JSON.stringify({ evidence, errors }, null, 2))

  await electronApp.close()

  if (errors.length > 0) process.exitCode = 1
}

main().catch(async (error) => {
  console.error('VIRUS E2E FAILED:', error)
  if (sampleRef) await unlink(sampleRef).catch(() => undefined)
  if (appRef) await appRef.close().catch(() => undefined)
  process.exitCode = 1
})
