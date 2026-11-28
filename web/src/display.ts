// How this device shows chat, as Discord's Accessibility settings: the chat text size, the
// message display (default or compact) and the space between message groups. Saved on this device.

export type MessageDisplay = 'default' | 'compact'
export const GROUP_SPACES = [0, 4, 8, 16, 24] as const
export const DEFAULT_GROUP_SPACE = 16
export const CHAT_FONTS = [12, 14, 15, 16, 18, 20, 24] as const
export const DEFAULT_CHAT_FONT = 16

export type Display = { messages: MessageDisplay; groupSpace: number; chatFont: number }

const pick = (key: string, stops: readonly number[], fallback: number) => {
  const value = Number(localStorage.getItem(key) ?? fallback)
  return stops.includes(value) ? value : fallback
}

export function savedDisplay(): Display {
  return {
    messages: localStorage.getItem('messageDisplay') === 'compact' ? 'compact' : 'default',
    groupSpace: pick('groupSpace', GROUP_SPACES, DEFAULT_GROUP_SPACE),
    chatFont: pick('chatFont', CHAT_FONTS, DEFAULT_CHAT_FONT),
  }
}

export function applyDisplay(display: Display) {
  const root = document.documentElement
  if (display.messages === 'compact') root.dataset['messages'] = 'compact'
  else delete root.dataset['messages']
  // The default keeps the measured gaps (desktop and phone differ); a chosen space is exact.
  if (display.groupSpace === DEFAULT_GROUP_SPACE) root.style.removeProperty('--group-gap')
  else root.style.setProperty('--group-gap', `${display.groupSpace}px`)
  if (display.chatFont === DEFAULT_CHAT_FONT) root.style.removeProperty('--chat-font')
  else root.style.setProperty('--chat-font', `${display.chatFont}px`)
}

export function saveDisplay(display: Display) {
  if (display.messages === 'compact') localStorage.setItem('messageDisplay', 'compact')
  else localStorage.removeItem('messageDisplay')
  if (display.groupSpace === DEFAULT_GROUP_SPACE) localStorage.removeItem('groupSpace')
  else localStorage.setItem('groupSpace', String(display.groupSpace))
  if (display.chatFont === DEFAULT_CHAT_FONT) localStorage.removeItem('chatFont')
  else localStorage.setItem('chatFont', String(display.chatFont))
  applyDisplay(display)
}

applyDisplay(savedDisplay())
