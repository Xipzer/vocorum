// Plain text for places that cannot render markdown: session titles, reply
// previews, sheet headers. Mentions become names, markdown marks go away.

export function plain(text: string, userName: (id: string) => string | null = () => null, channelName: (id: string) => string | null = () => null): string {
  return text
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${userName(id) ?? 'someone'}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${channelName(id) ?? 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(-?\d+)(?::\w)?>/g, (_, s: string) => new Date(Number(s) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]\n]+)\]\(<?https?:\/\/[^\s)>]+>?\)/g, '$1')
    .replace(/^\s{0,3}(#{1,3}|-#|>{1,3}|[-*]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|\|\||`)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\*\*|``?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// A project's wallpaper hue, from a fixed set that keeps clear of the status colours.
const HUES = ['0 210 255', '255 46 136', '64 224 160', '255 140 50', '120 140 255', '255 92 92', '230 200 60', '80 170 255']
export function wallHue(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]!
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

// Machine names as people say them: "desktop" reads "Desktop".
export const machineLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

// How a person is shown: their display name, else their username.
export const displayName = (u: { username: string; global_name?: string | null } | undefined) => (u ? (u.global_name ?? u.username) : 'Someone')
