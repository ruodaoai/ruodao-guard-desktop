import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'test-artifacts', 'ui')
const errors = []

async function main() {
  await mkdir(artifacts, { recursive: true })
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: root
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })

  await page.waitForSelector('.titlebar', { timeout: 15000 })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1040, 700)
  })
  await page.waitForTimeout(700)

  const shot = async (name) => {
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) })
    console.log(`[shot] ${name}`)
  }
  const overflow = async () => page.locator('.page-scroll').evaluate((el) => el.scrollWidth - el.clientWidth)

  await page.locator('.nav-item').filter({ hasText: '加速中心' }).first().click()
  await page.waitForSelector('.speed-hero-number b', { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(900)
  await shot('29-compact-speed-overview')
  console.log('[info] compact overview overflow:', await overflow())
  const heroCols = await page
    .locator('.speed-hero')
    .first()
    .evaluate((el) => getComputedStyle(el).flexWrap + ' | ' + getComputedStyle(el).display)
  console.log('[info] hero layout:', heroCols)

  for (const [label, name, ready] of [
    ['软件加速', '30-compact-speed-software', '.speed-app-icon'],
    ['网络加速', '31-compact-speed-network', '.speed-network-title b'],
    ['性能加速', '32-compact-speed-performance', '.plan-card, .speed-empty-note'],
    ['启动项管理', '33-compact-speed-startup', '.startup-row']
  ]) {
    await page.locator('.speed-tab').filter({ hasText: label }).click()
    await page.waitForSelector(ready, { timeout: 90000 }).catch(() => console.log(`[warn] ${label} still loading`))
    await page.waitForTimeout(800)
    await shot(name)
    console.log(`[info] ${label} compact overflow:`, await overflow())
    const rowScroll = await page
      .locator(label === '启动项管理' ? '.startup-row' : '.speed-tabs')
      .first()
      .evaluate((el) => (el ? el.scrollWidth - el.clientWidth : -1))
      .catch(() => -1)
    console.log(`[info] ${label} first-row overflow:`, rowScroll)
  }

  await page.locator('.nav-item').filter({ hasText: '系统修复' }).first().click()
  await page.waitForSelector('.repair-hero', { timeout: 20000 })
  await page
    .waitForFunction(
      () =>
        !document.querySelector('.repair-issue-skeleton') &&
        !document.querySelector('.repair-checks-card .skeleton') &&
        Boolean(document.querySelector('.repair-check-row')),
      { timeout: 120000 }
    )
    .catch(() => console.log('[warn] repair scan still running'))
  await page.waitForTimeout(900)
  await shot('34-compact-repair')
  console.log('[info] compact repair overflow:', await overflow())
  const cols = await page.locator('.repair-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
  console.log('[info] compact repair grid:', cols)

  await app.close()
  console.log('\nERRORS', JSON.stringify(errors, null, 2))
  if (errors.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('VERIFY FAILED:', error)
  process.exitCode = 1
})
