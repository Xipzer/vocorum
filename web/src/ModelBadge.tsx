// The model and its optional effort travel together. Keep the exact identifier
// available even when the visible model name is easier to read.
type Model = { id: string; effort?: string; source: string }

export function ModelBadge({ id, effort, source }: Model) {
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z][a-z\d-]*))?$/i.exec(id)
  const name = gpt ? `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map((s) => s[0]!.toUpperCase() + s.slice(1)).join(' ') : ''}` : id
  return <span className="model-badge" title={source}><span className="model-name">{name}</span>{effort && <> <span className="model-effort">{effort}</span></>}</span>
}

// Run footers put the model after elapsed time and optional context usage.
// An agent can follow it. A branch called foo#high is not a model field.
export function footerModel(items: string[]): { at: number; model: Model } | null {
  const elapsed = items.findIndex((v) => /^(?:\d+h\s*)?(?:\d+m\s*)?(?:<?\d+(?:\.\d+)?s)?$/.test(v) && /\d/.test(v))
  if (elapsed < 0) return null
  const at = elapsed + (/^\d+(?:\.\d+)?%$/.test(items[elapsed + 1] ?? '') ? 2 : 1)
  const source = items[at]
  const m = source && /^([\w.\-/:]+)(?:#([\w-]+))?$/.exec(source)
  if (!m || (!m[2] && !/[-.:/\d]/.test(m[1]!))) return null
  return { at, model: { id: m[1]!, effort: m[2], source } }
}

// Recognise only a finished /model reply whose display and raw ID agree.
// Unknown formats, errors and intermediate wizard steps keep the bot's words.
export function modelReceipt(text: string) {
  const lines = text.trim().split('\n')
  if (lines.length !== 4) return null
  const scope = lines[0] === 'Model set for this session:' ? 'This session' : lines[0] === 'Model preference set for this channel:' ? 'This channel' : lines[0] === 'Model preference set for all channels:' ? 'All channels' : null
  const display = /^\*\*([^*]+)\*\* \/ \*\*([^*]+)\*\*(?: \(([\w-]+)\))?$/.exec(lines[1]!)
  const raw = /^`([^`]+)`$/.exec(lines[2]!)?.[1]
  if (!scope || !display || !raw || !raw.endsWith(`/${display[2]}${display[3] ? ` (${display[3]})` : ''}`) || !lines[3]) return null
  return <div className="model-receipt"><ModelBadge id={display[2]!} effort={display[3]} source={raw} /><span>{scope} · {lines[3] === 'Applies from the next step.' ? 'from the next step' : lines[3]}</span></div>
}
