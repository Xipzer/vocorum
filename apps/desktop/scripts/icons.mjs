// Regenerate the raster and installer icons from the PWA's Vocorum mark.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const web = path.resolve(import.meta.dirname, '../../../web/public')
const dest = path.resolve(import.meta.dirname, '../src-tauri/icons')
const svg = await fs.readFile(path.join(web, 'icon.svg'), 'utf8')
const paint = (source, size, file) => sharp(Buffer.from(source)).resize(size, size).ensureAlpha().png().toFile(file)
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocorum-icons-'))
try {
  await paint(svg, 1024, path.join(tmp, 'master.png'))
  execFileSync('cargo', ['tauri', 'icon', path.join(tmp, 'master.png'), '-o', tmp])
  for (const file of ['icon.png', 'icon.icns', 'icon.ico', '32x32.png', '128x128.png', '128x128@2x.png']) await fs.copyFile(path.join(tmp, file), path.join(dest, file))
  for (const size of [192, 512]) await paint(svg, size, path.join(web, `icon-${size}.png`))
  // A template is only an alpha mask: no tile, and the system supplies the colour.
  await paint(svg.replace(/<rect[^>]*\/>/, '').replace(/stroke="#[\da-f]+"/i, 'stroke="black"'), 44, path.join(dest, 'tray-template.png'))
} finally { await fs.rm(tmp, { recursive: true, force: true }) }
