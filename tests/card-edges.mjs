// node tests/card-edges.mjs <built web directory>. Check the CSS actually linked by its index.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
const root = path.resolve(process.argv[2] || 'web/dist')
const index = fs.readFileSync(path.join(root,'index.html'),'utf8')
const links = [...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map(([tag]) => tag.match(/href="([^"]+)"/)[1])
assert.ok(links.length)
const sheets = links.map(h => fs.readFileSync(path.join(root,h.split('?')[0]),'utf8'))
console.log('Stylesheet SHA-256:',createHash('sha256').update(sheets.join('\n')).digest('hex'))
const cache = path.join(os.homedir(),'.cache/ms-playwright')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || fs.readdirSync(cache).filter(s=>/^chromium-\d+$/.test(s)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9))).map(s=>path.join(cache,s,'chrome-linux64/chrome')).find(fs.existsSync)
const browser = await chromium.launch({executablePath})
let count = 0
try {
  for (const width of [1280,390,320]) {
    const p = await browser.newPage({viewport:{width,height:800},deviceScaleFactor:2,hasTouch:width<768,isMobile:width<768})
    await p.setContent('<meta name="viewport" content="width=device-width,initial-scale=1">')
    for (const content of sheets) await p.addStyleTag({content})
    const palette = ['#e5a50a','#00d2ff','#3b82f6','#22c55e','#ef4444']
    for (const family of ['callout','bot','embed','approval','request','reminder','workspace']) {
      for (const colour of (['callout','bot','embed'].includes(family) ? palette : [family==='approval'||family==='request'?'#e5a50a':'#00d2ff'])) {
        let shortHeight = 0
        for (const long of [false,true]) {
          const text = long ? 'Review the longer garden note before printing it. '.repeat(7) : 'Garden note'
          const classes = {callout:'container accented',bot:'container accented',embed:'embed-card',approval:'approval open',request:'request-card pending',reminder:'reminder-row due',workspace:'ws-row ws-waiting'}
          await p.evaluate(({text,cls,family,colour})=>{
            const box=document.createElement(family==='workspace'?'button':'div');box.className=cls;box.id='sample';box.style.setProperty('--bar',colour);box.style.setProperty('--embed-color',colour)
            const body=document.createElement('span');body.className=({workspace:'ws-row-text',reminder:'reminder-text',request:'request-summary',embed:'embed-description'})[family] || 'markdown';body.textContent=text;box.append(body)
            const pane=document.createElement('main');pane.style.cssText='width:min(260px,90vw);margin:16px';pane.append(box);document.body.replaceChildren(pane)
          },{text,cls:classes[family],family,colour})
          const {data,info}=await sharp(await p.locator('#sample').screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true})
          if (!long) shortHeight=info.height; else assert.ok(info.height>shortHeight,`${family} must wrap`)
          const at=(x,y)=>data.subarray((Math.floor(y)*info.width+x)*3,(Math.floor(y)*info.width+x)*3+3).toString('hex')
          for (const [x,y,on] of [[8,5,true],[8,info.height-6,true],[5,info.height/2,true],[2,2,false],[2,info.height-3,false],[12,5,false],[12,info.height-6,false],[8,0,false],[8,info.height-1,false]]) assert.equal(at(x,y)===colour.slice(1),on,`${family} ${colour} ${width} ${long?'long':'short'} at ${x},${y}: ${at(x,y)}`)
          count++
        }
      }
    }
    await p.close()
  }
} finally { await browser.close() }
console.log(`${count} painted cases passed`)
