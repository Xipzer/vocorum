// Voice channels, as Discord's: a sidebar row with who is in it, a call screen with one tile
// per person (a ring while they speak), and a control bar to talk, deafen, set audio and
// leave. While connected, a strip above the user panel says where, with the same controls.
// The channel's own chat sits beside the call (Discord's "Show chat"): a pane on desktop, a
// full-height panel on phones, where a pill under the header keeps the call in reach elsewhere.

import { useEffect, useState, type ReactNode } from 'react'
import { Avatar } from './Avatar.tsx'
import type { Channel, HubState, VoiceState } from './api.ts'
import { E } from './emoji.tsx'
import { Icon } from './icons.tsx'
import { extensions } from './extensions.tsx'
import { can, P } from './perms.ts'
import { Sheet, below, type SheetAction, type SheetSpec } from './Sheet.tsx'
import { canPickOutput, join, leave, outputs, setDeaf, setMute, setNoise, setOutput, useVoice, type VoiceUi } from './voice.ts'
import './voice-room.css'

export const inVoice = (state: HubState, channelId: string) => (state.voice_states ?? []).filter((v) => v.channel_id === channelId)
const connectionLabel = (v: VoiceUi) => v.status === 'connecting' ? 'Connecting…' : v.listenOnly ? 'Voice connected · Listen-only' : 'Voice connected'
const nameOf = (state: HubState, id: string) => {
  const u = state.users.find((x) => x.id === id)
  return u ? (u.global_name ?? u.username) : 'Someone'
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const change = () => setMatches(media.matches)
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [query])
  return matches
}

// How long this device has been in the call.
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  return (
    <span className="num" role="timer" aria-label="Call time">
      {s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}` : Math.floor(s / 60)}:{two(s % 60)}
    </span>
  )
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
function Controls({ state, channel, here, chat }: { state: HubState; channel: Channel; here: boolean; chat?: { open: boolean; toggle: () => void } }) {
  const voice = useVoice()
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const canSpeak = can(P.SPEAK, channel)
  const micOff = voice.mute || voice.listenOnly || !canSpeak
  // Phones only: on desktop the header's button shows the chat.
  const chatButton = chat && (
    <button className="voice-button phone-chat" onClick={chat.toggle} aria-label={chat.open ? 'Hide chat' : 'Show chat'}>
      <Icon name="chat" size={24} />
    </button>
  )
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
          {chatButton}
          <button className="voice-button" onClick={(e) => void settingsSheet(below(e.currentTarget), voice).then(setSheet)} aria-label="Voice settings" title="Voice settings">
            <Icon name="gear" size={24} />
          </button>
          <button className="voice-button leave" onClick={leave} aria-label="Leave voice" title="Leave voice">
            <Icon name="hangup" size={26} />
          </button>
        </>
      ) : (
        <>
          {chatButton}
          <button className="voice-join" onClick={() => void join(channel.id, state.me.id)} disabled={voice.status === 'connecting'}>
          {voice.channelId && voice.channelId !== channel.id ? 'Move here' : 'Join voice'}
          </button>
        </>
      )}
      {sheet && <Sheet spec={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}

// The call screen for a voice channel.
const CHAT_KEY = 'voice:chat'
export function VoiceView({ channel, state, onMenu, chat }: { channel: Channel; state: HubState; onMenu: () => void; chat?: (onClose: () => void) => ReactNode }) {
  const voice = useVoice()
  // Where side panels lie over the page (phones, narrow windows) the call keeps the screen:
  // the chat opens over it when asked, and closes again.
  const over = useMedia('(max-width: 1100px)')
  const [sheet, setSheet] = useState(false)
  // Beside the call, the choice is remembered on this device; until one is made, a room
  // with messages shows them.
  const [choice, setChoice] = useState(() => localStorage.getItem(CHAT_KEY))
  const docked = choice ? choice === '1' : Boolean(channel.last_message_id)
  const chatOpen = Boolean(chat) && (over ? sheet : docked)
  const showChat = (open: boolean) => {
    if (over) return setSheet(open)
    localStorage.setItem(CHAT_KEY, open ? '1' : '0')
    setChoice(open ? '1' : '0')
  }
  const here = voice.channelId === channel.id && voice.status !== 'idle'
  const people = inVoice(state, channel.id)
  // Before the hub confirms the join, this device shows itself at once.
  const tiles = here && !people.some((v) => v.user_id === state.me.id) ? [...people, { user_id: state.me.id, channel_id: channel.id, self_mute: voice.mute, self_deaf: voice.deaf }] : people
  // Every extension's hook runs on every render (the list never changes); the first stage offered wins.
  const stage =
    extensions
      .map((e) => {
        const node = e.useVoiceStage?.({ channel, state, here }) ?? null
        return !e.ownerOnly || state.hub_owner === true ? node : null
      })
      .find((node) => node !== null) ?? null
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
          <span className="chat-sub">{here ? connectionLabel(voice) : people.length ? `${people.length} in voice` : 'Voice channel'}</span>
        </div>
        {chat && (
          <span className="chat-actions">
            <button className="icon-button desk-only" onClick={() => showChat(!chatOpen)} aria-pressed={chatOpen} aria-label={chatOpen ? 'Hide chat' : 'Show chat'} title={chatOpen ? 'Hide chat' : 'Show chat'}>
              <Icon name="chat" />
            </button>
          </span>
        )}
      </header>
      <div className="voice-room">
      <div className="voice-main">
      {stage ?? (
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
      )}
      {voice.error && (voice.channelId === channel.id || !voice.channelId) && <div className="voice-error" role="alert">{voice.error}</div>}
      <div className="voice-dock-bar">
        <Controls state={state} channel={channel} here={here} chat={chat && { open: chatOpen, toggle: () => showChat(!chatOpen) }} />
      </div>
      </div>
      {chat && chatOpen && (
        <aside className="side-panel voice-chat" role="complementary" aria-label="Chat">
          <header className="panel-head">
            <button className="icon-button panel-back" onClick={() => showChat(false)} aria-label="Close panel">
              <Icon name="back" size={22} />
            </button>
            <Icon name="speaker" size={20} className="panel-icon" />
            <div className="panel-title">
              <E>{channel.name}</E>
            </div>
            <button className="icon-button panel-close" onClick={() => showChat(false)} aria-label="Close">
              <Icon name="close" size={18} />
            </button>
          </header>
          {chat(() => showChat(false))}
        </aside>
      )}
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
        <span className={`voice-strip-status${voice.status === 'connecting' ? ' connecting' : ''}`}>{connectionLabel(voice)}</span>
        <span className="voice-strip-channel">
          <span className="voice-strip-place">
            <E>{channel?.name ?? 'Voice'}</E> / {guild}
          </span>
          {voice.since && <span className="voice-strip-time">· <Elapsed since={voice.since} /></span>}
        </span>
      </button>
      <button className={`icon-button${micOff ? ' off' : ''}`} onClick={() => setMute(!voice.mute)} disabled={voice.listenOnly} aria-label={micOff ? 'Unmute' : 'Mute'} title={micOff ? 'Unmute' : 'Mute'}>
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

// Phones, while connected and looking at anything but the room: the call under the header.
// The room's name returns to it; mute and leave are in reach.
export function CallPill({ state, current, onOpen }: { state: HubState; current: string | null; onOpen: (id: string) => void }) {
  const voice = useVoice()
  const phone = useMedia('(max-width: 767px)')
  const id = voice.status === 'idle' ? null : voice.channelId
  if (!phone || !id || id === current) return null
  const channel = state.channels.find((c) => c.id === id)
  const micOff = voice.mute || voice.listenOnly
  return (
    <div className="voice-strip call-pill" role="group" aria-label="Voice call" data-swipe="off">
      <button className="voice-strip-where" onClick={() => onOpen(id)} aria-label={`Return to ${channel?.name ?? 'voice'}`}>
        <span className={`voice-strip-status${voice.status === 'connecting' ? ' connecting' : ''}`}>
          <E>{channel?.name ?? 'Voice'}</E>
        </span>
        {voice.since && (
          <span className="voice-strip-channel">
            <Elapsed since={voice.since} />
          </span>
        )}
      </button>
      <button className={`icon-button${micOff ? ' off' : ''}`} onClick={() => setMute(!voice.mute)} disabled={voice.listenOnly} aria-label={micOff ? 'Unmute' : 'Mute'}>
        <Icon name={micOff ? 'mic-off' : 'mic'} size={20} />
      </button>
      <button className="icon-button leave" onClick={leave} aria-label="Leave voice">
        <Icon name="hangup" size={20} />
      </button>
    </div>
  )
}
