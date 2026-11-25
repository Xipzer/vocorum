import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { test, expect } from 'vitest'
import { Hub } from '../src/hub.ts'
import { P } from '../src/access.ts'
import { LOGIN, pairedDevice, startTestHub, TestDevice } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname,'../web/dist')
const cache = path.join(os.homedir(),'.cache/ms-playwright')
const chrome = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse().map(d=>path.join(cache,d,'chrome-linux64/chrome')).find(f=>fs.existsSync(f)) : undefined)

test.skipIf(!chrome || !fs.existsSync(path.join(webDir,'index.html')))('the thread bell has a scoped inbox; the profile bell includes both chats; revoked history stays private', async () => {
  const t = await startTestHub({ extensions:[] }); await t.hub.stop(); t.hub = new Hub({paths:t.paths,config:t.config,port:0,webDir,extensions:[]}); await t.hub.start()
  const owner=await pairedDevice(t.hub), demo=await startDemoBot(t.hub), browser=await chromium.launch({executablePath:chrome})
  try {
    const invite=await owner.json(`/client/guilds/${t.config.guildId}/invites`,{method:'POST',json:{username:'reader'}}), memberId=invite.user.id, login='scope-reader@example.test'
    await t.hub.store.setProfile(memberId,{tailscaleLogin:login}); await t.hub.refreshLogins()
    const member=new TestDevice(t.hub,{'tailscale-user-login':login}); await member.pair(invite.code)
    const a=await demo.thread.send(`<@${t.config.ownerUserId}> <@${memberId}> Review the cover.`)
    const b=await demo.website.send(`<@${t.config.ownerUserId}> <@${memberId}> Check the website.`)
    await t.hub.search.flush()
    const scoped=`/client/inbox?channel_id=${demo.thread.id}`, ids=(reply:{mentions:Array<{message:{id:string}}>})=>reply.mentions.map(x=>x.message.id)
    expect(ids(await owner.json(scoped))).toEqual([a.id]); expect(ids(await member.json(scoped))).toEqual([a.id]); expect(ids(await owner.json(`/client/inbox?guild_id=${t.config.guildId}`))).toEqual(expect.arrayContaining([a.id,b.id]))
    await owner.json(`/client/channels/${demo.kimaki.id}/permissions/${memberId}`,{method:'PUT',json:{type:1,allow:'0',deny:String(P.READ_MESSAGE_HISTORY)}})
    expect((await member.fetch(scoped)).status).toBe(403); expect(ids(await member.json('/client/inbox'))).not.toContain(a.id); expect(ids(await member.json('/client/inbox'))).toContain(b.id)
    expect((await owner.fetch('/client/inbox?channel_id=bad')).status).toBe(400)
    const c=await browser.newContext({viewport:{width:1440,height:900},extraHTTPHeaders:{'tailscale-user-login':LOGIN},serviceWorkers:'block'})
    const k=owner.cookie!.indexOf('='); await c.addCookies([{name:owner.cookie!.slice(0,k),value:owner.cookie!.slice(k+1),url:owner.origin.replace('http:','https:')+'/',secure:true,httpOnly:true}])
    const p=await c.newPage(); await p.goto(`${owner.origin}/#/c/${demo.thread.id}`)
    await p.getByRole('button',{name:'Notification settings',exact:true}).click(); await p.getByRole('menuitem',{name:'Mentions in this chat'}).click()
    const panel=p.getByRole('complementary').filter({has:p.locator('.panel-title',{hasText:'Mentions here'})}); await panel.getByText('Review the cover.',{exact:false}).waitFor()
    expect(await panel.getByText('Check the website.',{exact:false}).count()).toBe(0)
    await panel.locator('.mention-row').click(); await p.locator(`#m-${a.id}.highlight`).waitFor()
    await p.locator('.inbox-button').click(); const global=p.getByRole('complementary').filter({has:p.locator('.panel-title',{hasText:'Inbox'})})
    await global.locator('.ov-line').getByText('Review the cover.',{exact:false}).waitFor(); await global.getByText('Check the website.',{exact:false}).waitFor()
  } finally { await browser.close(); await demo.stop(); await t.cleanup() }
},45_000)
