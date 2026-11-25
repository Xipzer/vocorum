// Message composer: text, slash commands with autocomplete, file attachments,
// hold-to-record voice notes and replies. Discord's typing aids too: @, # and :
// suggestions, a formatting bar over a selection, Ctrl/Cmd+B/I/U, an emoji button,
// dropped files and a character count near the limit.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BOARD_CORRECT, correctedDraft, type BoardCorrection } from './board-document.ts'
import { EmojiPicker, rememberEmoji } from './EmojiPicker.tsx'
import { store, useStore } from './store.ts'
import { loadVoice, saveVoice, type VoiceDraft } from './voiceDraft.ts'
import { Sheet, usePress, type SheetAt, type SheetSpec } from './Sheet.tsx'
import { cronLabel, remindTime, whenPicker } from './remind.ts'
import { api, type Attachment, type Command, type CommandOption, type InteractionResult, type Message } from './api.ts'
import { Icon } from './icons.tsx'
import { customName, customTag, emojify, expandEmoji, serverEmoji } from './emoji.tsx'
import type { CustomEmojiInfo } from './api.ts'

// A pending file. The server keeps the name it was uploaded under, so a rename or a
// spoiler toggle uploads the kept File again under the new name.
type Upload = { key: string; file: File; name: string; description: string; spoiler: boolean; preview?: string; attachment?: Attachment; error?: string }

const LIMIT = 2000

const uploadName = (u: Pick<Upload, 'name' | 'spoiler'>) => (u.spoiler ? `SPOILER_${u.name}` : u.name)
const extension = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toUpperCase()

function UploadTile({ upload, onSpoiler, onEdit, onRemove, onRetry }: { upload: Upload; onSpoiler: () => void; onEdit: () => void; onRemove: () => void; onRetry: () => void }) {
  const busy = !upload.attachment && !upload.error
  const kind = upload.file.type.split('/')[0]
  return (
    <li className={`upload-tile${upload.spoiler ? ' spoilered' : ''}${upload.error ? ' failed' : ''}${busy ? ' busy' : ''}`} aria-label={uploadName(upload)}>
      <div className="upload-preview">
        {upload.error ? (
          <div className="upload-error" role="alert">
            <Icon name="warn" size={24} />
            {/* The tile is small: the short word here, the reason on hover and for screen readers. */}
            <span title={upload.error} aria-label={`Upload failed: ${upload.error}`}>
              Upload failed
            </span>
            <button className="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : upload.preview && kind === 'image' ? (
          <img src={upload.preview} alt={upload.description || upload.name} draggable={false} />
        ) : upload.preview && kind === 'video' ? (
          <video src={upload.preview} muted preload="metadata" />
        ) : (
          <div className="upload-file">
            <Icon name="file" size={40} />
            {extension(upload.name) && <span className="num">{extension(upload.name)}</span>}
          </div>
        )}
        {upload.spoiler && !upload.error && <span className="spoiler-pill">Spoiler</span>}
        {busy && <span className="upload-progress" role="progressbar" aria-label="Uploading" />}
      </div>
      <span className="upload-tile-name" title={upload.name}>
        {upload.name}
      </span>
      <div className="upload-actions" role="toolbar" aria-label="Attachment actions">
        <button className="icon-button" aria-pressed={upload.spoiler} aria-label={upload.spoiler ? 'Remove spoiler' : 'Spoiler attachment'} title={upload.spoiler ? 'Remove spoiler' : 'Spoiler attachment'} onClick={onSpoiler}>
          <Icon name={upload.spoiler ? 'eyeOff' : 'eye'} size={18} />
        </button>
        <button className="icon-button" aria-label="Modify attachment" title="Modify attachment" onClick={onEdit}>
          <Icon name="pencil" size={18} />
        </button>
        <button className="icon-button danger" aria-label="Remove attachment" title="Remove attachment" onClick={onRemove}>
          <Icon name="trash" size={18} />
        </button>
      </div>
    </li>
  )
}

function UploadEditor({ upload, onSave, onClose }: { upload: Upload; onSave: (name: string, description: string) => void; onClose: () => void }) {
  const [name, setName] = useState(upload.name)
  const [description, setDescription] = useState(upload.description)
  const valid = name.trim().length > 0
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
      <form
        className="modal upload-editor"
        aria-label="Modify attachment"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onSave(name.trim(), description.trim())
        }}
      >
        <div className="modal-header">
          <h2>{upload.name}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">File name</span>
            <input
              value={name}
              maxLength={200}
              autoFocus
              onFocus={(e) => {
                const dot = e.target.value.lastIndexOf('.')
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
              }}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Description</span>
            <span className="field-description">Alt text for people using screen readers.</span>
            <input value={description} maxLength={1024} placeholder="Add a description" onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!valid}>
            Save
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

type Suggestion = { key: string; label: string; hint?: string; insert: string; glyph?: React.ReactNode }

let emojiIndex: Array<[string, string]> | null = null
const loadEmoji = async () => (emojiIndex ??= (await import('./emoji-data.ts')).EMOJI_GROUPS.flatMap((g) => g.emoji))

// The @, # or : word the caret is in, if any.
function tokenAt(text: string, caret: number): { trigger: '@' | '#' | ':'; query: string; start: number } | null {
  const m = /(^|[\s(])([@#:])([\w.-]{0,32})$/.exec(text.slice(0, caret))
  if (!m) return null
  const trigger = m[2] as '@' | '#' | ':'
  if (trigger === ':' && m[3]!.length < 2) return null
  return { trigger, query: m[3]!.toLowerCase(), start: caret - m[3]!.length - 1 }
}

// Pixel position of a caret offset inside a textarea (a mirror element with the same box).
function caretPoint(el: HTMLTextAreaElement, offset: number) {
  const style = getComputedStyle(el)
  const mirror = document.createElement('div')
  for (const prop of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize'] as const) mirror.style[prop] = style[prop]
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  mirror.textContent = el.value.slice(0, offset)
  const mark = document.createElement('span')
  mark.textContent = '\u200b'
  mirror.appendChild(mark)
  document.body.appendChild(mirror)
  const r = el.getBoundingClientRect()
  const x = r.left + mark.offsetLeft - el.scrollLeft
  const y = r.top + mark.offsetTop - el.scrollTop
  mirror.remove()
  return { x, y }
}

const FORMATS: Array<{ key: string; label: string; wrap: [string, string]; glyph: React.ReactNode; line?: boolean }> = [
  { key: 'b', label: 'Bold', wrap: ['**', '**'], glyph: <b>B</b> },
  { key: 'i', label: 'Italic', wrap: ['*', '*'], glyph: <i style={{ fontFamily: 'Georgia, serif' }}>I</i> },
  { key: 'u', label: 'Underline', wrap: ['__', '__'], glyph: <u>U</u> },
  { key: 's', label: 'Strikethrough', wrap: ['~~', '~~'], glyph: <s>S</s> },
  { key: 'q', label: 'Quote', wrap: ['> ', ''], line: true, glyph: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M5 5v14M10 8h9M10 12h9M10 16h6" /></svg> },
  { key: 'c', label: 'Code', wrap: ['`', '`'], glyph: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></svg> },
  { key: 'p', label: 'Spoiler', wrap: ['||', '||'], glyph: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.6 3.4M6.6 6.6A17 17 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg> },
]

const VALUE_TYPES = new Set([3, 4, 5, 7, 10])

function SlashForm({
  command,
  channelId,
  channels,
  onCancel,
  onResult,
}: {
  command: Command
  channelId: string
  channels: Array<{ id: string; name: string }>
  onCancel: () => void
  onResult: (result: InteractionResult, name: string) => void
}) {
  const subcommands = command.options.filter((o) => o.type === 1)
  const [sub, setSub] = useState<string | null>(subcommands[0]?.name ?? null)
  const options = (sub ? (subcommands.find((s) => s.name === sub)?.options ?? []) : command.options).filter((o) => VALUE_TYPES.has(o.type))
  const [values, setValues] = useState<Record<string, string>>({})
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [focused, setFocused] = useState<string | null>(null)
  const [choices, setChoices] = useState<Array<{ name: string; value: string | number }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const submitting = useRef(false)
  const form = useRef<HTMLFormElement>(null)

  const typed = (option: CommandOption, raw: string) => (option.type === 4 ? Number.parseInt(raw, 10) : option.type === 10 ? Number(raw) : option.type === 5 ? raw === 'true' : raw)
  const built = (focus?: string) => {
    const list = options.filter((o) => values[o.name] !== undefined && (values[o.name] !== '' || o.name === focus)).map((o) => ({ name: o.name, type: o.type, value: typed(o, values[o.name]!), ...(o.name === focus && { focused: true }) }))
    return sub ? [{ name: sub, type: 1, options: list }] : list
  }

  const lookup = (option: CommandOption, value: string) => {
    window.clearTimeout(timer.current)
    if (!option.autocomplete) return
    timer.current = window.setTimeout(async () => {
      const opts = built(option.name).map((o) => o) as Array<Record<string, unknown>>
      const flat = sub ? ((opts[0]?.['options'] as Array<Record<string, unknown>>) ?? []) : opts
      const withValue = flat.some((o) => o['name'] === option.name) ? flat : [...flat, { name: option.name, type: option.type, value }]
      const payload = sub ? [{ name: sub, type: 1, options: withValue }] : withValue
      const result = await api.autocomplete(channelId, command.name, payload, option.name).catch(() => ({ choices: [] }))
      setChoices(result.choices)
    }, 200)
  }

  useEffect(() => {
    const first = options.find((o) => o.autocomplete)
    if (first) lookup(first, '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub])

  const missing = options.filter((o) => o.required && !values[o.name])
  const run = async () => {
    if (submitting.current || missing.length) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await api.command(channelId, command.name, built())
      if (!result.acknowledged) {
        setError(`The bot did not acknowledge /${command.name} within 3 seconds. Check the thread before trying again. Ref ${result.interactionId}.`)
        return
      }
      onResult(result, command.name)
      onCancel()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  // Choices for the focused option: static choices, true/false, channels, or the bot's autocomplete.
  const focusedOption = options.find((o) => o.name === focused)
  const typedText = focusedOption ? (labels[focusedOption.name] ?? values[focusedOption.name] ?? '').toLowerCase() : ''
  const listed: Array<{ name: string; value: string | number }> = !focusedOption
    ? []
    : focusedOption.choices?.length
      ? focusedOption.choices.filter((c) => c.name.toLowerCase().includes(typedText))
      : focusedOption.type === 5
        ? [{ name: 'True', value: 'true' }, { name: 'False', value: 'false' }]
        : focusedOption.type === 7
          ? channels.filter((c) => c.name.toLowerCase().includes(typedText.replace(/^#/, ''))).map((c) => ({ name: `#${c.name}`, value: c.id }))
          : focusedOption.autocomplete
            ? choices
            : []
  const choose = (option: CommandOption, choice: { name: string; value: string | number }) => {
    setValues({ ...values, [option.name]: String(choice.value) })
    setLabels({ ...labels, [option.name]: choice.name })
    // Move on to the next empty option, as Discord does.
    const next = options.find((o) => o.name !== option.name && !values[o.name])
    setFocused(next?.name ?? null)
    if (next) setTimeout(() => form.current?.querySelector<HTMLInputElement>(`[data-option="${CSS.escape(next.name)}"]`)?.focus(), 0)
  }

  // Discord's command line: the command as a chip, then each option inline as
  // "name: value", choices in a list above. Enter runs it; Backspace on an empty
  // first field drops the command; Escape cancels.
  return (
    <div className="slash-line-wrap">
      {focusedOption && listed.length > 0 && (
        <div className="palette" role="listbox">
          <div className="palette-head">{focusedOption.name}: {focusedOption.description}</div>
          {listed.map((choice) => (
            <button key={String(choice.value)} className="slash-item" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(focusedOption, choice)}>
              <span className="slash-name">{choice.name}</span>
            </button>
          ))}
        </div>
      )}
      <form className="slash-line" ref={form} aria-busy={busy} onSubmit={(e) => { e.preventDefault(); void run() }} onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.repeat || e.nativeEvent.isComposing)) e.preventDefault()
        if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel() }
      }}>
        <span className="slash-chip">/{command.name}</span>
        {subcommands.length > 0 &&
          subcommands.map((s) => (
            <button type="button" key={s.name} className={`slash-sub${s.name === sub ? ' on' : ''}`} onClick={() => setSub(s.name)}>
              {s.name}
            </button>
          ))}
        {options.map((option, i) => (
          <label key={option.name} className={`slash-arg${focused === option.name ? ' focus' : ''}${values[option.name] ? ' set' : ''}`}>
            <span className="slash-arg-name">
              {option.name}
              {option.required ? '' : '?'}:
            </span>
            <input
              data-option={option.name}
              autoFocus={i === 0}
              value={labels[option.name] ?? values[option.name] ?? ''}
              placeholder={option.description}
              inputMode={option.type === 4 || option.type === 10 ? 'decimal' : 'text'}
              size={Math.max(4, Math.min(28, (labels[option.name] ?? values[option.name] ?? option.description ?? '').length + 1))}
              onFocus={() => {
                setFocused(option.name)
                lookup(option, values[option.name] ?? '')
              }}
              onBlur={() => setTimeout(() => setFocused((f) => (f === option.name ? null : f)), 150)}
              onChange={(e) => {
                setLabels({ ...labels, [option.name]: e.target.value })
                setValues({ ...values, [option.name]: e.target.value })
                lookup(option, e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.repeat && focused === option.name && listed.length === 1 && values[option.name] !== String(listed[0]!.value)) {
                  e.preventDefault(); choose(option, listed[0]!)
                }
                if (e.key === 'Backspace' && i === 0 && !(values[option.name] ?? '')) onCancel()
              }}
            />
          </label>
        ))}
        <span className="slash-hint muted" role="status">{busy ? `Sending /${command.name}…` : missing.length ? `${missing.length} required` : 'Enter to run'}</span>
        <button type="submit" autoFocus={!options.length} className="icon-button send" disabled={busy || missing.length > 0} aria-label="Run command" title="Run (Enter)">
          <Icon name="send" />
        </button>
        <button type="button" disabled={busy} className="icon-button" onClick={onCancel} aria-label="Cancel command" title="Cancel (Esc)">
          <Icon name="close" size={18} />
        </button>
      </form>
      {error && <div className="error slash-error" role="alert">{error}</div>}
    </div>
  )
}

const clockSecs = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// Live input level as a row of bars.
function Level({ analyser }: { analyser: AnalyserNode | null }) {
  const [bars, setBars] = useState<number[]>(() => Array(24).fill(0.08))
  useEffect(() => {
    if (!analyser) return
    const data = new Uint8Array(analyser.fftSize)
    let frame = 0
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
      setBars((b) => [...b.slice(1), Math.max(0.08, Math.min(1, peak * 1.8))])
      frame = window.setTimeout(tick, 80)
    }
    tick()
    return () => window.clearTimeout(frame)
  }, [analyser])
  return (
    <span className="rec-level" aria-hidden>
      {bars.map((h, i) => (
        <i key={i} style={{ height: `${Math.round(h * 100)}%` }} />
      ))}
    </span>
  )
}

// Discord voice message waveform: up to 256 amplitude bytes, base64.
async function analyse(blob: Blob): Promise<{ durationSecs: number; waveform: string }> {
  const context = new AudioContext()
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer())
    const data = audio.getChannelData(0)
    const points = Math.min(256, Math.max(1, Math.floor(audio.duration * 10)))
    const size = Math.floor(data.length / points) || 1
    const bytes = new Uint8Array(points)
    let peak = 0
    const rms: number[] = []
    for (let p = 0; p < points; p++) {
      let sum = 0
      for (let i = p * size; i < (p + 1) * size && i < data.length; i++) sum += data[i]! * data[i]!
      const value = Math.sqrt(sum / size)
      rms.push(value)
      peak = Math.max(peak, value)
    }
    rms.forEach((value, p) => (bytes[p] = peak ? Math.round((value / peak) * 255) : 0))
    return { durationSecs: Math.round(audio.duration * 100) / 100, waveform: btoa(String.fromCharCode(...bytes)) }
  } finally {
    void context.close()
  }
}

function pickMime() {
  for (const type of ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4']) if (MediaRecorder.isTypeSupported(type)) return type
  return ''
}

// A typed draft survives closing the window, a relaunch and an app update: it lives in
// localStorage per chat and is removed once it is sent or emptied. A draft from before
// this change (kept only for the session) is carried over once.
function readDraft(key: string): string {
  try {
    const kept = localStorage.getItem(key)
    if (kept !== null) return kept
    const old = sessionStorage.getItem(key)
    if (old) { localStorage.setItem(key, old); sessionStorage.removeItem(key) }
    return old ?? ''
  } catch { return '' }
}
function writeDraft(key: string, text: string) {
  try {
    if (text) localStorage.setItem(key, text)
    else localStorage.removeItem(key)
  } catch { /* storage full or unavailable: the draft stays in the field */ }
}

export function Composer({
  channelId,
  placeholder,
  commands,
  channels,
  replyTo,
  onCancelReply,
  onResult,
  onError,
}: {
  channelId: string
  placeholder: string
  commands: Command[]
  channels: Array<{ id: string; name: string }>
  replyTo: Message | null
  onCancelReply: () => void
  onResult: (result: InteractionResult, name: string) => void
  onError: (message: string) => void
}) {
  const draftKey = `draft:${channelId}`
  const [text, setText] = useState(() => readDraft(draftKey))
  const [uploads, setUploads] = useState<Upload[]>([])
  const [command, setCommand] = useState<Command | null>(null)
  const [pick, setPick] = useState(0)
  const [recording, setRecording] = useState<{ started: number; cancel: boolean } | null>(null)
  const [now, setNow] = useState(Date.now())
  const recorder = useRef<{ media: MediaRecorder; chunks: Blob[]; stream: MediaStream; cancelled: boolean } | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const hub = useStore((d) => d.state)
  const voiceKey = `${hub?.guild.id}:${hub?.me.id}:${channelId}`
  const [draft, setDraft] = useState<VoiceDraft>(), [voiceBusy, setVoiceBusy] = useState(false)
  const voiceSending = useRef(false)
  useEffect(() => { let live = true; void loadVoice(voiceKey).then(d => { if (live) setDraft(d) }, () => {}); return () => { live = false } }, [voiceKey])
  const retained = draft?.key === voiceKey ? draft : undefined
  const [saveUrl, setSaveUrl] = useState('')
  useEffect(() => { if (!retained) { setSaveUrl(''); return }; const url = URL.createObjectURL(retained.blob); setSaveUrl(url); return () => URL.revokeObjectURL(url) }, [retained])
  const deliverVoice = async (d: VoiceDraft) => {
    if (voiceSending.current) return
    voiceSending.current = true; setVoiceBusy(true); setDraft(d)
    let durable = false
    try {
      await saveVoice(d.key,d).then(() => { durable = true }, () => {})
      if (!d.attachment) {
        const meta = await analyse(d.blob).catch(() => ({ durationSecs: 0, waveform: '' }))
        d.attachment = (await api.upload(d.blob,d.name,meta)).id
        await saveVoice(d.key,d).catch(() => {})
      }
      const posted = await api.send(channelId,{ content:'', attachmentIds:[d.attachment], voice:true, ...(d.reply && {replyTo:d.reply}) })
      store.confirmSent(posted)
      await saveVoice(d.key).catch(() => {}); setDraft(undefined); onCancelReply()
    } catch { onError(durable ? 'Voice note not confirmed. Your recording is saved on this device.' : 'Keep this window open. Save a copy of your recording before closing.') }
    finally { voiceSending.current = false; setVoiceBusy(false) }
  }
  const [caret, setCaret] = useState<{ start: number; end: number }>({ start: 0, end: 0 })
  const [suggestPick, setSuggestPick] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [emojiReady, setEmojiReady] = useState(Boolean(emojiIndex))
  const [emojiAt, setEmojiAt] = useState<DOMRect | null>(null)
  const [dragging, setDragging] = useState(false)
  const [bar, setBar] = useState<{ x: number; y: number } | null>(null)
  const emojiButton = useRef<HTMLButtonElement>(null)
  const mic = useRef<HTMLButtonElement>(null)
  const pressed = useRef(false)
  const locked = useRef(false)
  const downAt = useRef(0)
  const lastPos = useRef<{ x: number; y: number } | null>(null)
  const meter = useRef<AudioContext | null>(null)
  const levels = useRef<AnalyserNode | null>(null)

  const [editing, setEditing] = useState<string | null>(null)
  const pending = useRef(new Map<string, Promise<Attachment | null>>())
  const sending = useRef(false)
  const live = useRef(uploads)
  live.current = uploads
  const drop = (list: Upload[]) => {
    for (const u of list) {
      if (u.preview) URL.revokeObjectURL(u.preview)
      pending.current.delete(u.key)
    }
  }
  useEffect(() => () => drop(live.current), [])

  useEffect(() => {
    setText(readDraft(draftKey))
    drop(live.current)
    setUploads([])
    setEditing(null)
    setCommand(null)
  }, [draftKey])
  useEffect(() => writeDraft(draftKey, text), [draftKey, text])
  useEffect(() => {
    const receive = (event: Event) => {
      const e = event as CustomEvent<BoardCorrection>, el = textarea.current
      if (e.defaultPrevented || e.detail?.thread !== channelId || !el || el.disabled || command || recording || editing || sending.current) return
      const next = correctedDraft(el.value, e.detail)
      if (!next) return
      e.preventDefault(); setText(next); setCaret({ start: next.length, end: next.length })
      requestAnimationFrame(() => { if (textarea.current === el && el.value === next) { el.focus(); el.setSelectionRange(next.length, next.length) } })
    }
    window.addEventListener(BOARD_CORRECT, receive)
    return () => window.removeEventListener(BOARD_CORRECT, receive)
  }, [channelId, command, recording, editing])
  useEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`
  }, [text])
  useEffect(() => {
    if (replyTo) textarea.current?.focus()
  }, [replyTo])
  useEffect(() => {
    if (!recording) return
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [recording])

  const slashQuery = !command && /^\/(\S*)$/.exec(text)?.[1]
  const matches = slashQuery !== undefined && slashQuery !== false && slashQuery !== null ? commands.filter((c) => c.name.startsWith(slashQuery.toLowerCase())).slice(0, 12) : []

  const token = tokenAt(text, caret.start)
  useEffect(() => {
    if (token?.trigger === ':' && !emojiReady) void loadEmoji().then(() => setEmojiReady(true))
  }, [token?.trigger, emojiReady])
  const guildId = hub?.channels.find((c) => c.id === channelId)?.guild_id ?? hub?.threads.find((c) => c.id === channelId)?.guild_id ?? hub?.guild.id
  const [serverList, setServerList] = useState<CustomEmojiInfo[]>([])
  useEffect(() => {
    if (token?.trigger === ':') void serverEmoji(guildId).then(setServerList)
  }, [token?.trigger, guildId])
  const suggestions: Suggestion[] = (() => {
    if (!token || caret.start !== caret.end || dismissed === token.start || !hub) return []
    const q = token.query
    if (token.trigger === '@') {
      const people = hub.users
        .filter((u) => (u.global_name ?? '').toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
        .slice(0, 8)
        .map((u) => ({ key: u.id, label: u.global_name ?? u.username, hint: u.username, insert: `<@${u.id}> `, glyph: '@' }))
      const everyone = ['everyone', 'here'].filter((x) => x.startsWith(q)).map((x) => ({ key: x, label: `@${x}`, hint: x === 'here' ? 'Everyone online' : 'Everyone in the channel', insert: `@${x} ` }))
      return [...people, ...everyone].slice(0, 10)
    }
    if (token.trigger === '#') {
      return [...hub.channels.filter((c) => c.type === 0 || c.type === 5), ...hub.threads]
        .filter((c) => (c.guild_id ?? hub.guild.id) === guildId && (c.name ?? '').toLowerCase().includes(q))
        .sort((a, b) => Number(!(a.name ?? '').toLowerCase().startsWith(q)) - Number(!(b.name ?? '').toLowerCase().startsWith(q)))
        .slice(0, 10)
        .map((c) => ({ key: c.id, label: c.name ?? '', hint: hub.channels.find((p) => p.id === c.parent_id)?.name ?? undefined, insert: `<#${c.id}> `, glyph: hub.threads.includes(c) ? <Icon name="thread" size={16} /> : '#' }))
    }
    if (!emojiIndex) return []
    const own = serverList
      .filter((e) => e.name.toLowerCase().includes(q))
      .map((e) => ({ key: e.id, label: `:${e.name}:`, insert: `:${e.name}: `, glyph: customTag(e) }))
    const starts = emojiIndex.filter(([, name]) => name.toLowerCase().replace(/\s+/g, '_').startsWith(q))
    const rest = emojiIndex.filter(([, name]) => !name.toLowerCase().replace(/\s+/g, '_').startsWith(q) && name.toLowerCase().includes(q.replace(/_/g, ' ')))
    return [...own, ...[...starts, ...rest].map(([emoji, name]) => ({ key: emoji, label: `:${name.toLowerCase().replace(/[\s:]+/g, '_')}:`, insert: `${emoji} `, glyph: emoji }))].slice(0, 10)
  })()
  useEffect(() => setSuggestPick(0), [token?.trigger, token?.query])

  const replaceRange = (start: number, end: number, insert: string, select?: [number, number]) => {
    const next = text.slice(0, start) + insert + text.slice(end)
    const [a, b] = select ?? [start + insert.length, start + insert.length]
    if (textarea.current) {
      textarea.current.value = next
      textarea.current.setSelectionRange(a, b)
    }
    setText(next)
    setCaret({ start: a, end: b })
    requestAnimationFrame(() => {
      const el = textarea.current
      // Only if nothing changed since: never move a caret the user has moved on from.
      if (!el || el.value !== next || el.selectionStart !== el.selectionEnd || el.selectionStart === a) return
      el.focus()
      el.setSelectionRange(a, b)
      setCaret({ start: a, end: b })
    })
  }
  const chooseSuggestion = (s: Suggestion) => {
    if (!token) return
    if (token.trigger === ':') rememberEmoji(s.key)
    replaceRange(token.start, caret.start, s.insert)
  }

  // Wrap (or unwrap) the selection in a Discord marker; quote prefixes each line.
  const format = (f: (typeof FORMATS)[number]) => {
    const el = textarea.current
    const { start, end } = el ? { start: el.selectionStart, end: el.selectionEnd } : caret
    const [open, close] = f.wrap
    const chosen = text.slice(start, end)
    if (f.line) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1
      const block = text.slice(lineStart, end)
      const quoted = block.split('\n').every((l) => l.startsWith('> '))
      const next = quoted ? block.replace(/^> /gm, '') : block.replace(/^/gm, '> ')
      replaceRange(lineStart, end, next, [lineStart, lineStart + next.length])
      return
    }
    // How many of the marker's characters already sit on each side: ** around a word
    // is bold, not italic, so Ctrl+I there adds a star instead of removing one.
    const run = (from: number, step: number) => {
      let n = 0
      while (text[from + n * step] === open[0]) n++
      return n
    }
    const before = run(start - 1, -1)
    const after = run(end, 1)
    const wrapped =
      open === '*' ? before === after && (before === 1 || before === 3) : open === '**' ? before === after && before >= 2 : text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close
    if (wrapped) {
      replaceRange(start - open.length, end + close.length, chosen, [start - open.length, end - open.length])
      return
    }
    replaceRange(start, end, open + chosen + close, [start + open.length, end + open.length])
  }
  const trackCaret = () => {
    const el = textarea.current
    if (!el) return
    setCaret({ start: el.selectionStart, end: el.selectionEnd })
  }
  // The formatting bar floats over the start of a selection (pointer devices only).
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el || caret.start === caret.end || document.activeElement !== el || window.matchMedia('(pointer: coarse)').matches) return setBar(null)
    const at = caretPoint(el, caret.start)
    const end = caretPoint(el, caret.end)
    setBar({ x: at.y === end.y ? (at.x + end.x) / 2 : at.x + 60, y: at.y })
  }, [caret.start, caret.end])

  const chooseCommand = (c: Command) => {
    setCommand(c)
    setText('')
    setPick(0)
  }

  const patchUpload = (key: string, patch: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)))

  // Uploads under `filename`; a later call for the same tile supersedes this one.
  // The latest job per tile stays in `pending`, settled or not, for send() to await.
  const startUpload = (key: string, file: File, filename: string) => {
    patchUpload(key, { attachment: undefined, error: undefined })
    const job: Promise<Attachment | null> = api.upload(file, filename).then(
      (attachment) => {
        if (pending.current.get(key) !== job) return null
        patchUpload(key, { attachment })
        return attachment
      },
      (e: unknown) => {
        if (pending.current.get(key) !== job) return null
        patchUpload(key, { error: e instanceof Error ? e.message : 'Upload failed' })
        return null
      },
    )
    pending.current.set(key, job)
  }

  const addFiles = (files: FileList | File[]) => {
    const added = [...files].map((file): Upload => {
      const spoiler = file.name.startsWith('SPOILER_')
      const visual = /^(image|video)\//.test(file.type)
      return { key: `${file.name}-${Math.random()}`, file, name: spoiler ? file.name.slice(8) || 'file' : file.name, description: '', spoiler, ...(visual && { preview: URL.createObjectURL(file) }) }
    })
    setUploads((list) => [...list, ...added])
    for (const u of added) startUpload(u.key, u.file, uploadName(u))
  }

  const changeUpload = (u: Upload, patch: Pick<Partial<Upload>, 'name' | 'description' | 'spoiler'>) => {
    const next = { ...u, ...patch }
    patchUpload(u.key, patch)
    if (uploadName(next) !== uploadName(u) || u.error) startUpload(u.key, u.file, uploadName(next))
  }

  const removeUpload = (u: Upload) => {
    drop([u])
    setUploads((list) => list.filter((x) => x.key !== u.key))
  }

  // Right-click or hold Send: post it later instead (text only; the hub posts it as you).
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const canSchedule = useStore((d) => d.reminders !== null)
  const schedule = async (when: { at: number } | { cron: string; at: number }) => {
    const content = text
    const s = await api.schedule({ channel_id: channelId, content: await expandEmoji(content, guildId), ...('cron' in when ? { cron: when.cron } : { at: when.at }) })
    store.upsertScheduled(s)
    setText((t) => (t === content ? '' : t))
    store.notice('cron' in when ? `Scheduled: ${cronLabel(when.cron, s.next_at)}.` : `Message scheduled for ${remindTime(when.at)}.`)
  }
  const scheduleSheet = (at: SheetAt): SheetSpec => {
    const now = new Date()
    const nine = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9).getTime()
    const options = [
      { label: 'In 1 hour', at: now.getTime() + 3_600_000 },
      { label: 'Tomorrow', at: nine(1) },
      { label: 'Next week', at: nine(((8 - now.getDay()) % 7) || 7) },
    ]
    const run = (when: { at: number }) => void schedule(when).catch((e: Error) => onError(e.message))
    return {
      at,
      title: 'Schedule message',
      groups: [
        [{ label: 'Send now', icon: 'send', run: () => void send() }],
        options.map((o) => ({ label: o.label, sub: remindTime(o.at).replace(/^Tomorrow /, ''), icon: 'clock' as const, run: () => run({ at: o.at }) })),
        [{ label: 'Pick a time', icon: 'pencil', run: () => whenPicker.open?.({ title: 'Schedule message', action: 'Schedule', repeat: true, onPick: schedule }) }],
      ],
    }
  }
  const sendPress = usePress((at) => {
    if (!canSchedule || !text.trim()) return
    if (uploads.length) return onError('Scheduled messages are text only. Remove the files to schedule it.')
    setSheet(scheduleSheet(at))
  })
  const send = async () => {
    if (matches.length && slashQuery !== '') {
      chooseCommand(matches[pick] ?? matches[0]!)
      return
    }
    const files = uploads
    if (!text.trim() && files.length === 0) return
    if (sending.current) return
    if (files.some((u) => u.error)) return onError('An attachment failed to upload. Retry or remove it first.')
    sending.current = true
    const content = text
    try {
      // Wait for uploads still in flight (a rename or spoiler toggle just before sending).
      const ids: string[] = []
      const descriptions: Record<string, string> = {}
      for (const u of files) {
        const attachment = await pending.current.get(u.key)
        if (!attachment) return
        ids.push(attachment.id)
        if (u.description.trim()) descriptions[attachment.id] = u.description.trim()
      }
      try {
        const posted = await api.send(channelId, { content: await expandEmoji(content, guildId), attachmentIds: ids, ...(Object.keys(descriptions).length && { descriptions }), ...(replyTo && { replyTo: replyTo.id }) })
        store.confirmSent(posted)
        setText((t) => (t === content ? '' : t))
        drop(files)
        setUploads((list) => list.filter((x) => !files.some((u) => u.key === x.key)))
        onCancelReply()
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      sending.current = false
    }
  }

  // Voice notes. Touch: hold to record, release to send, slide away to cancel.
  // A click (mouse) or a quick tap locks recording on: then Send or Enter
  // sends, Cancel or Esc drops it. Works the same on desktop and phones.
  const startRecording = async (event: React.PointerEvent) => {
    event.preventDefault()
    if (recorder.current || retained || voiceSending.current) return
    mic.current?.setPointerCapture(event.pointerId)
    pressed.current = true
    downAt.current = Date.now()
    lastPos.current = { x: event.clientX, y: event.clientY }
    locked.current = event.pointerType === 'mouse'
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Released before the microphone opened: a hold that ended (drop it) unless it was a tap (lock on).
      if (!pressed.current && !locked.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const mimeType = pickMime()
      const media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const state = { media, chunks: [] as Blob[], stream, cancelled: false }
      media.ondataavailable = (e) => e.data.size && state.chunks.push(e.data)
      media.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop())
        meter.current?.close().catch(() => {})
        meter.current = null
        if (state.cancelled) return
        const blob = new Blob(state.chunks, { type: media.mimeType || mimeType || 'audio/webm' })
        // The recorder stopped before the microphone delivered sound: only container framing.
        if (blob.size < 1024) return onError('Nothing was recorded. Check the microphone and try again.')
        const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'
        await deliverVoice({key:voiceKey, blob, name:`voice-message.${ext}`, reply:replyTo?.id})
      }
      // A live level meter while recording.
      try {
        const audio = new AudioContext()
        const analyser = audio.createAnalyser()
        analyser.fftSize = 256
        audio.createMediaStreamSource(stream).connect(analyser)
        meter.current = audio
        levels.current = analyser
      } catch {
        levels.current = null
      }
      media.start(250)
      recorder.current = state
      setRecording({ started: Date.now(), cancel: false })
      setNow(Date.now())
    } catch (e) {
      onError(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Where the finger is now: from moves, since some browsers report 0,0 on release.
  const outside = () => {
    const rect = mic.current?.getBoundingClientRect()
    const at = lastPos.current
    if (!rect || !at) return false
    return at.x < rect.left - 60 || at.y < rect.top - 60
  }

  const finish = (send: boolean) => {
    pressed.current = false
    locked.current = false
    const state = recorder.current
    recorder.current = null
    setRecording(null)
    if (!state) return
    state.cancelled = !send
    if (state.media.state !== 'inactive') state.media.stop()
  }

  const stopRecording = (event: React.PointerEvent) => {
    pressed.current = false
    // A quick tap (or any click) keeps recording until Send or Cancel.
    if (locked.current || Date.now() - downAt.current < 350) {
      locked.current = true
      return
    }
    void event
    finish(!outside())
  }

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      if (!locked.current) return
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  // Leaving the channel mid-recording drops the note.
  const recordingIn = useRef(channelId)
  useEffect(() => {
    if (recordingIn.current !== channelId && recorder.current) finish(false)
    recordingIn.current = channelId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  return (
    <>
      {retained && <div className="footer-line" role="group" aria-label="Voice recording"><span>{voiceBusy ? 'Sending voice note…' : 'Unsent voice note'}</span>{!voiceBusy && <><button className="button" onClick={() => void deliverVoice(retained)}>Retry</button>{saveUrl && <a className="button" href={saveUrl} download={retained.name}>Save audio</a>}<button onClick={() => { if (window.confirm('Discard this recording?')) void saveVoice(voiceKey).then(() => setDraft(undefined), () => onError('Could not discard the draft.')) }}>Discard</button></>}</div>}
      {replyTo && (
        <div className="footer-line">
          <span>
            Replying to <strong>{replyTo.author.global_name ?? replyTo.author.username}</strong>
          </span>
          <button className="icon-button" onClick={onCancelReply} aria-label="Cancel reply">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {command && <SlashForm command={command} channelId={channelId} channels={channels} onCancel={() => setCommand(null)} onResult={onResult} />}
      {matches.length > 0 && (
        <div className="palette" role="listbox">
          {matches.map((c, index) => (
            <button key={c.id} className={`slash-item${index === pick ? ' on' : ''}`} onMouseEnter={() => setPick(index)} onClick={() => chooseCommand(c)}>
              <span className="slash-name">/{c.name}</span>
              <span className="muted">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="palette suggest" role="listbox" aria-label={token?.trigger === '@' ? 'Members' : token?.trigger === '#' ? 'Channels' : 'Emoji'}>
          {suggestions.map((s, index) => (
            <button key={s.key} role="option" aria-selected={index === suggestPick} className={`slash-item${index === suggestPick ? ' on' : ''}`} onMouseEnter={() => setSuggestPick(index)} onMouseDown={(e) => e.preventDefault()} onClick={() => chooseSuggestion(s)}>
              {s.glyph && <span className={`suggest-glyph${token?.trigger === ':' ? ' emoji' : ''}`}>{token?.trigger === ':' ? emojify(String(s.glyph)) : s.glyph}</span>}
              <span className="slash-name">{s.label}</span>
              {s.hint && <span className="muted">{s.hint}</span>}
            </button>
          ))}
        </div>
      )}
      {bar &&
        createPortal(
          <div className="format-bar" role="toolbar" aria-label="Formatting" style={{ left: bar.x, top: bar.y }} onMouseDown={(e) => e.preventDefault()}>
            {FORMATS.map((f, i) => (
              <button key={f.key} className={`format-button${i === 4 ? ' gap' : ''}`} aria-label={f.label} title={f.label} onClick={() => format(f)}>
                {f.glyph}
              </button>
            ))}
          </div>,
          document.body,
        )}
      {emojiAt && (
        <EmojiPicker
          anchor={emojiAt}
          guildId={guildId}
          onPick={(emoji) => {
            rememberEmoji(emoji)
            // A server emoji reads as :name: while typing; sending turns it back into the emoji.
            replaceRange(caret.start, caret.end, customName(emoji) ? `:${customName(emoji)}:` : emoji)
            setEmojiAt(null)
          }}
          onClose={() => setEmojiAt(null)}
        />
      )}
      {uploads.length > 0 && (
        <ul className="upload-tiles" aria-label="Attachments">
          {uploads.map((u) => (
            <UploadTile
              key={u.key}
              upload={u}
              onSpoiler={() => changeUpload(u, { spoiler: !u.spoiler })}
              onEdit={() => setEditing(u.key)}
              onRemove={() => removeUpload(u)}
              onRetry={() => startUpload(u.key, u.file, uploadName(u))}
            />
          ))}
        </ul>
      )}
      {(() => {
        const u = uploads.find((x) => x.key === editing)
        return (
          u && (
            <UploadEditor
              upload={u}
              onClose={() => setEditing(null)}
              onSave={(name, description) => {
                changeUpload(u, { name, description })
                setEditing(null)
                textarea.current?.focus()
              }}
            />
          )
        )
      })()}
      {!command && (
        <div
          className={`composer${recording ? ' recording' : ''}${dragging ? ' dropping' : ''}`}
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes('Files')) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return
            e.preventDefault()
            setDragging(false)
            addFiles(e.dataTransfer.files)
          }}
        >
          <button className="icon-button attach" onClick={() => fileInput.current?.click()} aria-label="Attach files">
            <Icon name="plus" size={20} />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }} />
          {recording ? (
            <div className="recording-label">
              <span className="rec-dot" />
              <span className="num">{clockSecs(Math.floor((now - recording.started) / 1000))}</span>
              <Level analyser={levels.current} />
              {locked.current ? (
                <>
                  <button className="link-button rec-cancel" onClick={() => finish(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <span className="muted rec-hint">Slide away to cancel</span>
              )}
            </div>
          ) : (
            <textarea
              ref={textarea}
              rows={1}
              value={text}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(e) => {
                setText(e.target.value)
                setCaret({ start: e.target.selectionStart, end: e.target.selectionEnd })
                setDismissed(null)
              }}
              onSelect={trackCaret}
              onBlur={() => setBar(null)}
              onFocus={trackCaret}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault()
                  addFiles(e.clipboardData.files)
                }
              }}
              onKeyDown={(e) => {
                if (suggestions.length) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSuggestPick((p) => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
                    return
                  }
                  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                    e.preventDefault()
                    chooseSuggestion(suggestions[suggestPick] ?? suggestions[0]!)
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setDismissed(token!.start)
                    return
                  }
                }
                if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
                  const f = FORMATS.find((x) => x.key === e.key.toLowerCase() && 'biu'.includes(x.key))
                  if (f) {
                    e.preventDefault()
                    format(f)
                    return
                  }
                }
                if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault()
                  setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
                  return
                }
                if (matches.length && !e.nativeEvent.isComposing && !e.shiftKey && (e.key === 'Tab' || e.key === 'Enter')) {
                  e.preventDefault()
                  if (!e.repeat) chooseCommand(matches[pick] ?? matches[0]!)
                  return
                }
                // Up in an empty box edits your last message, like Discord.
                if (e.key === 'ArrowUp' && !text && !uploads.length && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault()
                  window.dispatchEvent(new CustomEvent('vocorum:edit-last', { detail: channelId }))
                  return
                }
                const touch = window.matchMedia('(pointer: coarse)').matches
                if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
                if (e.key === 'Escape' && replyTo) onCancelReply()
              }}
            />
          )}
          {!recording && text.length > LIMIT - 200 && <span className={`char-count num${text.length > LIMIT ? ' over' : ''}`}>{LIMIT - text.length}</span>}
          {!recording && (
            <button ref={emojiButton} className="icon-button emoji-button" aria-label="Emoji" title="Emoji" onMouseDown={(e) => e.preventDefault()} onClick={() => {
                if (emojiAt) return setEmojiAt(null)
                // Above the whole box, 8px clear of it, right edge on the button (Discord's spot).
                const b = emojiButton.current!.getBoundingClientRect()
                const box = (emojiButton.current!.closest('.footer') ?? emojiButton.current!.closest('.composer'))?.getBoundingClientRect() ?? b
                setEmojiAt(new DOMRect(b.x, box.top, b.width, b.bottom - box.top))
              }}>
              <Icon name="smile" />
            </button>
          )}
          {text.trim() || uploads.length ? (
            <button className="icon-button send" {...sendPress} onClick={() => void send()} aria-label="Send" title={canSchedule ? 'Send (right-click to schedule)' : 'Send'}>
              <Icon name="send" />
            </button>
          ) : (
            recording && locked.current ? (
              <button className="icon-button send" onClick={() => finish(true)} aria-label="Send voice message" title="Send (Enter)">
                <Icon name="send" />
              </button>
            ) : (
              <button ref={mic} className={`icon-button mic${recording ? ' live' : ''}`} onPointerDown={(e) => void startRecording(e)} onPointerMove={(e) => { if (pressed.current) lastPos.current = { x: e.clientX, y: e.clientY } }} onPointerUp={stopRecording} onPointerCancel={(e) => (locked.current ? undefined : finish(false), void e)} onContextMenu={(e) => e.preventDefault()} aria-label="Record a voice message" title="Voice message: click to record, or hold">
                <Icon name="mic" />
              </button>
            )
          )}
        </div>
      )}
      {sheet && <Sheet spec={sheet} onClose={() => setSheet(null)} />}
    </>
  )
}
