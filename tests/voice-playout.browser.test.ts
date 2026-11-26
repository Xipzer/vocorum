// Two independent paired browsers use generated, distinguishable microphone
// tones. Observe the stream assigned to the app's own output player; a socket
// frame, a speaking indicator or a running audio clock alone cannot pass this.
import fs from 'node:fs'
import { createHash, X509Certificate } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { test, expect } from 'vitest'
import { ChannelType } from 'discord.js'
import { Hub } from '../src/hub.ts'
import { initHub } from '../src/config.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'

const webDir=process.env['VOCORUM_REVIEW_WEB']??path.resolve(import.meta.dirname,'../web/dist'), cache=path.join(os.homedir(),'.cache/ms-playwright')
const exe=process.env['PLAYWRIGHT_CHROMIUM']??(fs.existsSync(cache)?fs.readdirSync(cache).filter(s=>/^chromium-\d+$/.test(s)).sort().reverse().map(s=>path.join(cache,s,'chrome-linux64/chrome')).find(s=>fs.existsSync(s)):undefined)
function tone(file:string,hz:number){const samples=48000*4,b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)b.writeInt16LE(Math.round(8500*Math.sin(i*hz*2*Math.PI/48000)),44+i*2);fs.writeFileSync(file,b)}
function listenToAppOutput(){
  const errors:string[]=[];window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason?.message??e.reason).slice(0,100)));Object.assign(window,{voiceTestErrors:errors})
  const media=navigator.mediaDevices, get=media.getUserMedia.bind(media)
  media.getUserMedia=async opts=>{const stream=await get(opts);const ctx=new AudioContext(),mic=ctx.createMediaStreamSource(stream),a=ctx.createAnalyser(),quiet=ctx.createGain();quiet.gain.value=0;mic.connect(a).connect(quiet).connect(ctx.destination);await ctx.resume();Object.assign(window,{micSample:()=>{const data=new Float32Array(a.fftSize);a.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((v,x)=>v+x*x,0)/data.length)}});return stream}
  const proto=HTMLMediaElement.prototype, descriptor=Object.getOwnPropertyDescriptor(proto,'srcObject')!
  Object.defineProperty(proto,'srcObject',{...descriptor,set(stream:MediaStream|null){
    descriptor.set!.call(this,stream);if(!(this instanceof HTMLAudioElement)||!stream)return
    const ctx=new AudioContext({sampleRate:48000}),input=ctx.createMediaStreamSource(stream),meter=ctx.createAnalyser();meter.fftSize=4096;meter.smoothingTimeConstant=0;input.connect(meter)
    // A muted observer branch in a test page, not another microphone or
    // another path into the voice server. Its samples come from the app mix.
    const zero=ctx.createGain();zero.gain.value=0;meter.connect(zero).connect(ctx.destination);void ctx.resume()
    const sample=()=>{ const time=new Float32Array(meter.fftSize),bins=new Float32Array(meter.frequencyBinCount);meter.getFloatTimeDomainData(time);meter.getFloatFrequencyData(bins);let peak=0;for(let i=1;i<bins.length;i++)if(bins[i]!>bins[peak]!)peak=i;return {rms:Math.sqrt(time.reduce((x,v)=>x+v*v,0)/time.length),hz:peak*ctx.sampleRate/meter.fftSize,playing:!(this as HTMLAudioElement).paused} }
    Object.assign(window,{sampleAppOutput:sample})
  }})
}
const level=(p:Page)=>p.evaluate(()=> (window as Window & {sampleAppOutput?:()=>{rms:number;hz:number;playing:boolean}}).sampleAppOutput?.()??{rms:0,hz:0,playing:false})
test.skipIf(!exe||!fs.existsSync(path.join(webDir,'index.html')))('two paired clients receive only the other microphone at playout, honour mute/deafen and leave cleanly',async()=>{
  // Worklets use a separate browser loader. The ordinary loopback test page's
  // extraHTTPHeaders do not apply to that loader. Use the real, authenticated
  // private *test* listener on loopback, with only its fresh certificate trusted.
  const t=await startTestHub({extensions:[]});await t.hub.stop();const host='hub.home.arpa';const config=initHub(t.paths,{privateListener:{address:'127.0.0.1',port:0,httpPort:null,names:[host],allowedCidrs:['127.0.0.0/8']}});t.hub=new Hub({paths:t.paths,config,port:0,webDir,extensions:[]});await t.hub.start();const bot=await startDemoBot(t.hub),browsers:Browser[]=[]
  const privateOrigin=`https://${host}:${t.hub.privateListener!.port}`,cert=new X509Certificate(fs.readFileSync(t.hub.privateListener!.files.cert)),pin=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64')
  try{
    const room=await bot.kimaki.guild.channels.create({name:'Fixture listening room',type:ChannelType.GuildVoice}),owner=await pairedDevice(t.hub,'First test client'),login='second-listener@example.test'
    const invite=await owner.json(`/client/guilds/${t.config.guildId}/invites`,{method:'POST',json:{username:'second_listener'}});await t.hub.store.setProfile(invite.user.id,{tailscaleLogin:login});await t.hub.refreshLogins();const peer=new TestDevice(t.hub,{'tailscale-user-login':login});await peer.pair(invite.code)
    const make=async(by:TestDevice,hz:number)=>{const f=path.join(t.paths.root,`microphone-${hz}.wav`);tone(f,hz);const b=await chromium.launch({executablePath:exe,args:[`--host-resolver-rules=MAP ${host} 127.0.0.1`,`--ignore-certificate-errors-spki-list=${pin}`,'--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+f,'--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});browsers.push(b);const c=await b.newContext({viewport:{width:1250,height:820},serviceWorkers:'block',permissions:['microphone']});const i=by.cookie!.indexOf('=');await c.addCookies([{name:by.cookie!.slice(0,i),value:by.cookie!.slice(i+1),secure:true,httpOnly:true,url:privateOrigin+'/'}]);await c.addInitScript(listenToAppOutput);const p=await c.newPage();p.setDefaultTimeout(6500);await p.goto(`${privateOrigin}/#/c/${room.id}`);await p.getByRole('button',{name:'Join voice'}).click();await p.locator('.voice-strip-status').filter({hasText:'Voice connected'}).waitFor();return p}
    const [a,b]=await Promise.all([make(owner,440),make(peer,760)])
    const frequency=async(p:Page,expected:number)=>{const r=await level(p);return r.playing&&r.rms>.012&&Math.abs(r.hz-expected)<22?r:undefined}
    const [atA,atB]=await Promise.all([waitFor(()=>frequency(a,760)),waitFor(()=>frequency(b,440))]).catch(async err=>{throw new Error(`Pair playout: ${JSON.stringify(await Promise.all([a,b].map(async p=>({sample:await level(p),diagnostics:await p.evaluate(()=>({mic:(window as any).micSample?.(),errors:(window as any).voiceTestErrors})),context:await p.locator('.voice-error').allTextContents(),speaking:await p.locator('.voice-tile.speaking').count()}))))}`,{cause:err})});expect(Math.abs(atA.hz-atB.hz)).toBeGreaterThan(270)
    const controls=(p:Page)=>p.getByRole('toolbar',{name:'Voice controls'});await controls(b).getByRole('button',{name:'Mute',exact:true}).click();await waitFor(async()=>(await level(a)).rms<.004);await waitFor(()=>frequency(b,440))
    await controls(b).getByRole('button',{name:'Unmute',exact:true}).click();await waitFor(()=>frequency(a,760));await controls(a).getByRole('button',{name:'Deafen',exact:true}).click();await waitFor(async()=>(await level(a)).rms<.004);await waitFor(()=>frequency(b,440));await controls(a).getByRole('button',{name:'Undeafen',exact:true}).click();await waitFor(()=>frequency(a,760))
    await Promise.all([a,b].map(p=>controls(p).getByRole('button',{name:'Leave voice'}).click()));await waitFor(async()=>(await owner.json('/client/state')).voice_states.length===0)
    if(process.env['HUB_SCREENSHOTS'])fs.writeFileSync(path.join(process.env['HUB_SCREENSHOTS'],'voice-playout.json'),JSON.stringify({source:'Two generated microphones; independently paired loopback browsers',expected_hz:[760,440],measured:[atA,atB],mute:true,deafen:true,empty_after_leave:true},null,2)+'\n')
  }finally{await Promise.all(browsers.map(b=>b.close()));await bot.stop();await t.cleanup()}
},60_000)
