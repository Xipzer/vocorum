// Voice channels, as Discord's: a sidebar row with who is in it, a call screen with one tile
// per person (a ring while they speak), and a control bar to talk, deafen, set audio and
// leave. While connected, a strip above the user panel says where, with the same controls.

import { useEffect, useState } from 'react'
import { Avatar } from './Avatar.tsx'
import type { Channel, HubState, VoiceState } from './api.ts'
import { E } from './emoji.tsx'
import { Icon } from './icons.tsx'
import { can, P } from './perms.ts'
import { Sheet, below, type SheetAction, type SheetSpec } from './Sheet.tsx'
import { canPickOutput, join, leave, outputs, setDeaf, setMute, setNoise, setOutput, useVoice, type VoiceUi } from './voice.ts'

export const inVoice = (state: HubState, channelId: string) => (state.voice_states ?? []).filter((v) => v.channel_id === channelId)
const nameOf = (state: HubState, id: string) => {
  const u = state.users.find((x) => x.id === id)
  return u ? (u.global_name ?? u.username) : 'Someone'
}

// Under a voice channel in the sidebar: who is in it.
export function VoicePeople({ state, channel }: { state: HubState; channel: Channel }) {
  const voice = useVoice()
  const people = inVoice(state, channel.id)
  if (!people.length) return null
  return (
    <div className="voice-people">
      {people.map((v) => (
        <span key={v.user_id} className={`voice-person${voice.speaking[v.user_id] ? ' speaking' : ''}`}>
          <Avatar id={v.user_id} name={nameOf(state, v.user_id)} size="inline" version={state.users.find((u) => u.id === v.user_id)?.avatar} />
          <span className="voice-person-name">
            <span className="voice-person-label">
              <E>{nameOf(state, v.user_id)}</E>
            </span>
            <Activity state={state} id={v.user_id} speaking={Boolean(voice.speaking[v.user_id])} />
          </span>
          <StateIcons v={v} />
        </span>
      ))}
    </div>
  )
}

// What a bot in voice is doing while it is quiet: thinking, or the step it is on. Speaking
// takes over (the ring says it); a person never shows one.
function Activity({ state, id, speaking, tile }: { state: HubState; id: string; speaking: boolean; tile?: boolean }) {
  const text = state.presence?.[id]?.activity
  if (!text || speaking) return null
  return (
    <span className={tile ? 'voice-activity tile' : 'voice-activity'} role="status">
      <i className="voice-activity-dots" aria-hidden="true">
        <b />
        <b />
        <b />
      </i>
      {text}
    </span>
  )
}

function StateIcons({ v }: { v: VoiceState }) {
  return (
    <>
      {v.self_deaf ? <Icon name="headphones-off" size={14} className="voice-flag" /> : v.self_mute ? <Icon name="mic-off" size={14} className="voice-flag" /> : null}
    </>
  )
}

// The audio settings menu: deafen, noise suppression, where sound plays.
async function settingsSheet(at: SheetSpec['at'], voice: VoiceUi): Promise<SheetSpec> {
  const devices = canPickOutput ? await outputs() : []
  const groups: SheetAction[][] = [
    [{ label: 'Deafen', sub: 'Turns off all sound', icon: 'headphones-off', checked: voice.deaf, run: () => setDeaf(!voice.deaf) }],
    [
      { label: 'Noise suppression: standard', radio: true, checked: voice.noise === 'standard', run: () => void setNoise('standard') },
      { label: 'Noise suppression: none', radio: true, checked: voice.noise === 'none', run: () => void setNoise('none') },
    ],
  ]
  if (devices.length > 1) groups.push(devices.map((d, i) => ({ label: d.label || (d.deviceId === 'default' ? 'System default' : `Speaker ${i + 1}`), radio: true, checked: (voice.output || 'default') === d.deviceId, run: () => void setOutput(d.deviceId) })))
  return { title: 'Voice settings', at, groups }
}

// The controls: mute, deafen, settings, leave; or mute and Join before joining.
function Controls({ state, channel, here }: { state: HubState; channel: Channel; here: boolean }) {
  const voice = useVoice()
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const canSpeak = can(P.SPEAK, channel)
  const micOff = voice.mute || voice.listenOnly || !canSpeak
  return (
    <div className="voice-controls" role="toolbar" aria-label="Voice controls">
      <button className={`voice-button${micOff ? ' off' : ''}`} onClick={() => setMute(!voice.mute)} aria-pressed={micOff} aria-label={micOff ? 'Unmute' : 'Mute'} title={micOff ? 'Unmute' : 'Mute'} disabled={voice.listenOnly && here}>
        <Icon name={micOff ? 'mic-off' : 'mic'} size={24} />
      </button>
      {here ? (
        <>
          <button className={`voice-button${voice.deaf ? ' off' : ''}`} onClick={() => setDeaf(!voice.deaf)} aria-pressed={voice.deaf} aria-label={voice.deaf ? 'Undeafen' : 'Deafen'} title={voice.deaf ? 'Undeafen' : 'Deafen'}>
            <Icon name={voice.deaf ? 'headphones-off' : 'headphones'} size={24} />
          </button>
          <button className="voice-button" onClick={(e) => void settingsSheet(below(e.currentTarget), voice).then(setSheet)} aria-label="Voice settings" title="Voice settings">
            <Icon name="gear" size={24} />
          </button>
          <button className="voice-button leave" onClick={leave} aria-label="Leave voice" title="Leave voice">
            <Icon name="hangup" size={26} />
          </button>
        </>
      ) : (
        <button className="voice-join" onClick={() => void join(channel.id, state.me.id)} disabled={voice.status === 'connecting'}>
          {voice.channelId && voice.channelId !== channel.id ? 'Move here' : 'Join voice'}
        </button>
      )}
      {sheet && <Sheet spec={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}

// The call screen for a voice channel.
export function VoiceView({ channel, state, onMenu }: { channel: Channel; state: HubState; onMenu: () => void }) {
  const voice = useVoice()
  const here = voice.channelId === channel.id && voice.status !== 'idle'
  const people = inVoice(state, channel.id)
  // Before the hub confirms the join, this device shows itself at once.
  const tiles = here && !people.some((v) => v.user_id === state.me.id) ? [...people, { user_id: state.me.id, channel_id: channel.id, self_mute: voice.mute, self_deaf: voice.deaf }] : people
  return (
    <section className="chat voice-view">
      <header className="chat-header">
        <button className="icon-button menu" onClick={onMenu} aria-label="Channels">
          <Icon name="back" size={22} className="phone-only" />
          <Icon name="sidebar" size={20} className="desk-only-icon" />
        </button>
        <div className="chat-titles">
          <div className="crumbs">
            <span className="chat-title">
              <Icon name="speaker" size={18} className="title-icon" />
              <span className="title-text">
                <E>{channel.name}</E>
              </span>
            </span>
          </div>
          <span className="chat-sub">{here ? (voice.status === 'connecting' ? 'Connecting…' : 'Voice connected') : people.length ? `${people.length} in voice` : 'Voice channel'}</span>
        </div>
      </header>
      <div className="voice-stage">
        {tiles.length === 0 ? (
          <div className="voice-empty">
            <b>No one’s here yet</b>
            <span>When you’re ready to talk, just hop in.</span>
          </div>
        ) : (
          <div className={`voice-tiles n${Math.min(tiles.length, 4)}`}>
            {tiles.map((v) => (
              <div key={v.user_id} className={`voice-tile${voice.speaking[v.user_id] ? ' speaking' : ''}`}>
                <Avatar id={v.user_id} name={nameOf(state, v.user_id)} size="panel" version={state.users.find((u) => u.id === v.user_id)?.avatar} />
                <Activity state={state} id={v.user_id} speaking={Boolean(voice.speaking[v.user_id])} tile />
                <span className="voice-tile-name">
                  <StateIcons v={v} />
                  <E>{nameOf(state, v.user_id)}</E>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {voice.error && (voice.channelId === channel.id || !voice.channelId) && <div className="voice-error" role="alert">{voice.error}</div>}
      <div className="voice-dock-bar">
        <Controls state={state} channel={channel} here={here} />
      </div>
    </section>
  )
}

// Above the user panel while connected: where, and quick controls.
export function VoiceStrip({ state, onOpen }: { state: HubState; onOpen: (id: string) => void }) {
  const voice = useVoice()
  const on = Boolean(voice.channelId) && voice.status !== 'idle'
  // The channel list makes room for the strip.
  useEffect(() => {
    document.documentElement.dataset['voice'] = on ? 'on' : 'off'
  }, [on])
  if (!on) return null
  const channel = state.channels.find((c) => c.id === voice.channelId)
  const guild = state.guilds?.find((g) => g.id === channel?.guild_id)?.name ?? state.guild.name
  const micOff = voice.mute || voice.listenOnly
  return (
    <div className="voice-strip">
      <button className="voice-strip-where" onClick={() => channel && onOpen(channel.id)}>
        <span className={`voice-strip-status${voice.status === 'connecting' ? ' connecting' : ''}`}>{voice.status === 'connecting' ? 'Connecting…' : 'Voice connected'}</span>
        <span className="voice-strip-channel">
          <E>{channel?.name ?? 'Voice'}</E> / {guild}
        </span>
      </button>
      <button className={`icon-button${micOff ? ' off' : ''}`} onClick={() => setMute(!voice.mute)} aria-label={micOff ? 'Unmute' : 'Mute'} title={micOff ? 'Unmute' : 'Mute'}>
        <Icon name={micOff ? 'mic-off' : 'mic'} size={20} />
      </button>
      <button className={`icon-button${voice.deaf ? ' off' : ''}`} onClick={() => setDeaf(!voice.deaf)} aria-label={voice.deaf ? 'Undeafen' : 'Deafen'} title={voice.deaf ? 'Undeafen' : 'Deafen'}>
        <Icon name={voice.deaf ? 'headphones-off' : 'headphones'} size={20} />
      </button>
      <button className="icon-button leave" onClick={leave} aria-label="Leave voice" title="Leave voice">
        <Icon name="hangup" size={20} />
      </button>
    </div>
  )
}
