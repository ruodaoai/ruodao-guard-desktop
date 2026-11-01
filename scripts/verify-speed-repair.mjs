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
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(1280, 840)
  })
  await page.waitForTimeout(800)

  const shot = async (name) => {
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) })
    console.log(`[shot] ${name}`)
  }

  const overflow = async (selector) =>
    page.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth)

  const nav = async (label) => {
    await page.locator('.nav-item').filter({ hasText: label }).first().click()
    await page.waitForTimeout(500)
  }

  await nav('加速中心')
  await page.waitForSelector('.speed-tabs', { timeout: 20000 })
  await page
    .waitForFunction(() => Boolean(document.querySelector('.speed-hero-number b')), { timeout: 60000 })
    .catch(() => console.log('[warn] speed overview still loading'))
  await page.waitForTimeout(1200)
  await shot('20-speed-overview')
  console.log('[info] tiles:', await page.locator('.speed-tile').count())
  console.log('[info] tabs:', await page.locator('.speed-tab').count())
  console.log('[info] speed overflow:', await overflow('.page-scroll'))
  const heroPad = await page.locator('.speed-hero').first().evaluate((el) => getComputedStyle(el).padding)
  const tileBg = await page.locator('.speed-tile').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  console.log('[info] hero padding:', heroPad, '| tile bg:', tileBg)
  if (!heroPad.startsWith('24px')) errors.push(`speed hero padding unexpected: ${heroPad}`)

  for (const [label, name, ready] of [
    ['软件加速', '21-speed-software', '.speed-app-icon'],
    ['网络加速', '22-speed-network', '.speed-network-title b'],
    ['性能加速', '23-speed-performance', '.plan-card, .speed-empty-note'],
    ['启动项管理', '24-speed-startup', '.startup-row']
  ]) {
    await page.locator('.speed-tab').filter({ hasText: label }).click()
    await page.waitForSelector(ready, { timeout: 90000 }).catch(() => console.log(`[warn] ${label} still loading`))
    await page.waitForTimeout(900)
    await shot(name)
    console.log(`[info] ${label} overflow:`, await overflow('.page-scroll'))
  }

  await nav('系统修复')
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
  await page.waitForTimeout(1200)
  await shot('25-repair')
  console.log('[info] issues:', await page.locator('.repair-issue').count())
  console.log('[info] checks:', await page.locator('.repair-check-row').count())
  console.log('[info] repair overflow:', await overflow('.page-scroll'))
  const gridCols = await page.locator('.repair-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
  console.log('[info] repair grid columns:', gridCols)
  const scroller = page.locator('.page-scroll').last()
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await page.waitForTimeout(400)
  await shot('26-repair-lower')

  await scroller.evaluate((el) => el.scrollTo(0, 0))
  await page.locator('button', { hasText: '一键修复安全项' }).click()
  await page.waitForSelector('.modal-panel', { timeout: 8000 })
  await page.waitForTimeout(300)
  await shot('27-repair-confirm')
  const ackVisible = await page.locator('.danger-ack input').count()
  console.log('[info] risky ack:', ackVisible)
  const confirmDisabled = await page
    .locator('.modal-foot .btn-danger, .modal-foot .btn-primary')
    .last()
    .isDisabled()
  console.log('[info] confirm disabled before ack:', confirmDisabled)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  console.log('[info] dialog closed:', (await page.locator('.modal-panel').count()) === 0)

  await nav('加速中心')
  await page.waitForSelector('.speed-hero-number b', { timeout: 30000 }).catch(() => {})
  await page.locator('button', { hasText: '一键加速' }).first().click()
  await page.waitForSelector('.modal-panel', { timeout: 8000 })
  await page.waitForTimeout(300)
  await shot('28-speed-confirm')
  console.log('[info] speed confirm title:', await page.locator('.modal-head h3').innerText())
  await page.keyboard.press('Escape')

  await app.close()
  console.log('\nERRORS', JSON.stringify(errors, null, 2))
  if (errors.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('VERIFY FAILED:', error)
  process.exitCode = 1
})
