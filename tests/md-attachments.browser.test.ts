// A .md attachment previews as rendered Markdown, with a switch to its source, as on Discord.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { AttachmentBuilder } from 'discord.js'
import { expect, test } from 'vitest'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const chrome = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse().map((d) => path.join(cache, d, 'chrome-linux64/chrome')).find((f) => fs.existsSync(f)) : undefined)
const shots = process.env['HUB_SCREENSHOTS']

const report = [
  '# Nightly report',
  '',
  'All **three** jobs finished. Details: [build log](https://example.com/log).',
  '',
  '| Job | Time | Result |',
  '| --- | ---: | --- |',
  '| build | 4.1 min | passed |',
  '| tests | 9.8 min | passed |',
  '| deploy | 0.7 min | passed |',
  '',
  '```ts',
  "export const ok = await check('web')",
  '```',
  '',
  '<script>window.pwned = true</script>',
  '<b>raw html</b>',
  '<img src="x" onerror="window.pwned = true">',
  '[run me](javascript:window.pwned=true) and <a href="javascript:window.pwned=true">this</a> and ![pic](javascript:window.pwned=true)',
  '<iframe src="javascript:window.pwned=true"></iframe>',
  '',
  '- first follow-up',
  '- second follow-up',
  ...Array.from({ length: 30 }, (_, i) => `- extra note ${i + 1}`),
].join('\n')

test.skipIf(!chrome || !fs.existsSync(path.join(webDir, 'index.html')))('a .md attachment renders as Markdown, collapses, and switches to its source', async () => {
  const t = await startTestHub({ extensions: [] }); await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] }); await t.hub.start()
  const owner = await pairedDevice(t.hub), demo = await startDemoBot(t.hub), browser = await chromium.launch({ executablePath: chrome })
  try {
    const sent = await demo.website.send({ content: 'Report attached.', files: [new AttachmentBuilder(Buffer.from(report), { name: 'report.md' })] })
    for (const viewport of [{ width: 1584, height: 991 }, { width: 390, height: 844 }]) {
      const phone = viewport.width < 600
      const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
      const k = owner.cookie!.indexOf('='); await ctx.addCookies([{ name: owner.cookie!.slice(0, k), value: owner.cookie!.slice(k + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
      const page = await ctx.newPage(); page.setDefaultTimeout(10_000)
      await page.goto(`${owner.origin}/#/c/${demo.website.id}`)
      const card = page.locator(`#m-${sent.id} .text-file`)
      const body = card.locator('.text-file-markdown')
      await body.locator('h1', { hasText: 'Nightly report' }).waitFor()
      expect(await body.locator('table th').allTextContents()).toEqual(['Job', 'Time', 'Result'])
      expect(await body.locator('tbody tr').count()).toBe(3)
      expect(await body.locator('pre code').textContent()).toContain("export const ok = await check('web')")
      expect(await body.locator('a[href="https://example.com/log"]').getAttribute('rel')).toMatch(/noopener/)
      // Raw HTML is shown as text, never run or rendered.
      expect(await body.textContent()).toContain('<script>window.pwned = true</script>')
      expect(await body.locator('script, b, img, iframe').count()).toBe(0)
      expect(await body.textContent()).toContain('<img src="x" onerror="window.pwned = true">')
      // javascript: links stay text: no anchor carries them, and clicking the words runs nothing.
      expect(await body.locator('a').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href).filter((href) => !/^https?:/.test(href)))).toEqual([])
      await body.getByText('run me', { exact: false }).click()
      expect(await page.evaluate(() => [...document.querySelectorAll('[onerror], [onclick], iframe')].length)).toBe(0)
      expect(await page.evaluate(() => (window as { pwned?: boolean }).pwned)).toBeUndefined()
      // Collapsed until Expand.
      const collapsed = (await body.boundingBox())!.height
      expect(collapsed).toBeLessThanOrEqual(232)
      await card.getByRole('button', { name: 'Expand' }).click()
      await expect.poll(async () => (await body.boundingBox())!.height).toBeGreaterThan(collapsed)
      if (shots) await card.screenshot({ path: path.join(shots, `md-attachment-${phone ? 'phone' : 'desktop'}.png`) })
      await card.getByRole('button', { name: 'Collapse' }).click()
      await page.mouse.move(0, 0); await page.waitForTimeout(300)
      if (shots) await page.screenshot({ path: path.join(shots, `md-attachment-${phone ? 'phone' : 'desktop'}-page.png`) })
      // The source view shows the file as written.
      await card.getByRole('button', { name: 'View source' }).click()
      await expect.poll(() => card.locator('pre.text-file-body code').textContent()).toMatch(/^# Nightly report\n/)
      expect(await body.count()).toBe(0)
      if (shots) await card.screenshot({ path: path.join(shots, `md-attachment-${phone ? 'phone' : 'desktop'}-source.png`) })
      await card.getByRole('button', { name: 'View formatted' }).click()
      await body.locator('h1').waitFor()
      await ctx.close()
    }
  } finally { await browser.close(); await demo.stop(); await t.cleanup() }
}, 90_000)

test.skipIf(!chrome || !fs.existsSync(path.join(webDir, 'index.html')))('a .md attachment over 100 KB stays a download card', async () => {
  const t = await startTestHub({ extensions: [] }); await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] }); await t.hub.start()
  const owner = await pairedDevice(t.hub), demo = await startDemoBot(t.hub), browser = await chromium.launch({ executablePath: chrome })
  try {
    const big = `# Big\n\n${'A line of notes that repeats.\n'.repeat(4000)}`
    const sent = await demo.website.send({ content: 'Big report.', files: [new AttachmentBuilder(Buffer.from(big), { name: 'big.md' })] })
    const ctx = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
    const k = owner.cookie!.indexOf('='); await ctx.addCookies([{ name: owner.cookie!.slice(0, k), value: owner.cookie!.slice(k + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
    const page = await ctx.newPage(); page.setDefaultTimeout(10_000)
    await page.goto(`${owner.origin}/#/c/${demo.website.id}`)
    const message = page.locator(`#m-${sent.id}`)
    await message.getByText('big.md').waitFor()
    expect(big.length).toBeGreaterThan(100_000)
    expect(await message.locator('.text-file').count()).toBe(0)
    expect(await message.locator('.file-box').count()).toBe(1)
    await ctx.close()
  } finally { await browser.close(); await demo.stop(); await t.cleanup() }
}, 90_000)
