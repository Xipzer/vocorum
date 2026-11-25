// Inline outline icons (1.75 stroke, round caps): no emoji or text glyphs in chrome.

const PATHS = {
  thread: 'M4.5 5.5h15v10h-7l-4.5 3.5v-3.5H4.5z',
  // The breadcrumb identifies a thread, rather than a direct-message bubble.
  threadCrumb: 'm10 3 11 8-2.4 3.2-11-8zM6.7 7.8l11 8-2.4 3.2-11-8zM4 13.3l9.6 7-2.4 2.3L2 16z',
  voiceChannel: 'M2 8h4.4l5-4.8c.6-.6 1.6-.2 1.6.7v16.2c0 .9-1 1.3-1.6.7l-5-4.8H2zM15.1 8.4l1.4-1.5a7.1 7.1 0 0 1 0 10.2l-1.4-1.5a5 5 0 0 0 0-7.2zM18.3 5.3l1.4-1.5a11.4 11.4 0 0 1 0 16.4l-1.4-1.5a9.4 9.4 0 0 0 0-13.4z',
  mic: 'M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3ZM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5',
  send: 'M4 12 20 4.5 15.5 20 11.5 13 4 12ZM11.5 13 20 4.5',
  plus: 'M12 5v14M5 12h14',
  key: 'M11.5 15a3.5 3.5 0 1 1-7 0a3.5 3.5 0 0 1 7 0ZM10.5 12.5 19 4M16 7l2.5 2.5M13.5 9.5l2 2',
  archive: 'M4.5 4.5h15v4h-15zM5.5 8.5v11h13v-11M10 12.5h4',
  unarchive: 'M4.5 4.5h15v4h-15zM5.5 8.5v11h13v-11M12 17.5v-5.5M9.5 14.5 12 12l2.5 2.5',
  pencil: 'M4.5 19.5 5.5 15 15.5 5l3.5 3.5-10 10-4.5 1Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  shield: 'M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6l-7-2.5Z',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17ZM12 7.5V12l3 2',
  repeat: 'M4.5 11V9.5a3 3 0 0 1 3-3h11M16 4l2.5 2.5L16 9M19.5 13v1.5a3 3 0 0 1-3 3h-11M8 20l-2.5-2.5L8 15',
  close: 'M6 6l12 12M18 6 6 18',
  signout: 'M10 4.5H5.5v15H10M15 8l4 4-4 4M19 12H9',
  reply: 'M10 8 5 12.5l5 4.5M5.5 12.5H14a5 5 0 0 1 5 5v1',
  trash: 'M5 7h14M10 7V5h4v2M6.5 7l1 12.5h9l1-12.5',
  file: 'M6 3.5h8l4.5 4.5v12.5H6zM14 3.5V8h4.5',
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z',
  back: 'm15 6-6 6 6 6',
  chevron: 'm9 6 6 6-6 6',
  down: 'm6 9 6 6 6-6',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM16 16l4.5 4.5',
  bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  copy: 'M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4',
  warn: 'M12 4 2.5 20h19zM12 10v4.5M12 17.5v.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v5.5M12 7.5v.01',
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8 12.5l2.5 2.5L16 9.5',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 9l6 6M15 9l-6 6',
  todo: 'M5 5.5h14v13H5zM8.5 9.5h7M8.5 13h7M8.5 16h4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 9.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Z',
  eyeOff: 'M3 3l18 18M10.6 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.6 6.9A16 16 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 5-1.5M10 10a2.75 2.75 0 0 0 4 4',
  star: 'm12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  hash: 'M9.5 4 8 20M16 4l-1.5 16M4.5 9h15M4 15h15',
  stop: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM9.5 9.5h5v5h-5z',
  pin: 'M9 4.5h6M10 4.5v5l-3 4h10l-3-4v-5M12 13.5v6',
  at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1',
  feed: 'M5 6h14M5 12h14M5 18h9',
  chat: 'M5 5h14v10H9l-4 4V5Z',
  server: 'M4.5 5.5h15v5h-15zM4.5 13.5h15v5h-15zM8 8h.01M8 16h.01',
  share: 'M12 15V4M8 8l4-4 4 4M6 12v7h12v-7',
  sidebar: 'M4.5 5.5h15v13h-15zM9.5 5.5v13',
  more: 'M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM19 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z',
  members: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 19.5c.6-3.2 3.2-5 6.5-5s5.9 1.8 6.5 5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.8c1.9.6 3.2 2.2 3.5 4.7',
  threads: 'M4.5 5.5h11v8h-6l-3.5 3v-3h-1.5zM15.5 9.5h4v8h-1.5v3l-3.5-3h-5v-2',
  gear: 'M10.22 6.17L10.44 3.95A8.2 8.2 0 0 1 13.56 3.95L13.78 6.17A6.1 6.1 0 0 1 14.86 6.61L16.59 5.20A8.2 8.2 0 0 1 18.80 7.41L17.39 9.14A6.1 6.1 0 0 1 17.83 10.22L20.05 10.44A8.2 8.2 0 0 1 20.05 13.56L17.83 13.78A6.1 6.1 0 0 1 17.39 14.86L18.80 16.59A8.2 8.2 0 0 1 16.59 18.80L14.86 17.39A6.1 6.1 0 0 1 13.78 17.83L13.56 20.05A8.2 8.2 0 0 1 10.44 20.05L10.22 17.83A6.1 6.1 0 0 1 9.14 17.39L7.41 18.80A8.2 8.2 0 0 1 5.20 16.59L6.61 14.86A6.1 6.1 0 0 1 6.17 13.78L3.95 13.56A8.2 8.2 0 0 1 3.95 10.44L6.17 10.22A6.1 6.1 0 0 1 6.61 9.14L5.20 7.41A8.2 8.2 0 0 1 7.41 5.20L9.14 6.61A6.1 6.1 0 0 1 10.22 6.17ZM12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z',
  smile: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  external: 'M14 4.5h5.5V10M19.5 4.5 11 13M10 6H4.5v13.5H18V14',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14',
  forward: 'M14 8l4.5 4.5L14 17M18.5 12.5H10a5 5 0 0 0-5 5v1',
  join: 'M4.5 12h14M13.5 6.5 19 12l-5.5 5.5',
  leave: 'M19.5 12h-14M10.5 6.5 5 12l5.5 5.5',
  boost: 'M12 3.5 18.5 9 12 20.5 5.5 9zM5.5 9h13M12 3.5v17',
  phone: 'M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 4.5 6a2 2 0 0 1 2-2Z',
  image: 'M4.5 5.5h15v13h-15zM4.5 15.5l4.5-4.5 4 4 2.5-2.5 4 4M15 9.5h.01',
  poll: 'M5 19.5V13M10 19.5V5M15 19.5v-9M20 19.5v-4',
  slash: 'M15 4 9 20',
  speaker: 'M4.5 9.5h3.5l4.5-4v13l-4.5-4H4.5zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11',
  'mic-off': 'M15 10.5v-4a3 3 0 0 0-5.7-1.3M9 9v2.5a3 3 0 0 0 4.7 2.5M5.5 11.5a6.5 6.5 0 0 0 10.8 4.9M18.4 12.6a6.5 6.5 0 0 0 .1-1.1M12 18v2.5M4.5 4.5l15 15',
  headphones: 'M4.5 17v-4.5a7.5 7.5 0 0 1 15 0V17M4.5 14h3v5.5h-3zM16.5 14h3v5.5h-3z',
  'headphones-off': 'M4.5 17v-4.5a7.4 7.4 0 0 1 1.6-4.6M8.6 5.9A7.5 7.5 0 0 1 19.5 12.5V17M4.5 14h3v5.5h-3zM16.5 14h3v5.5h-3zM4 4l16 16',
  hangup: 'M3.5 14c4.7-4.3 12.3-4.3 17 0l-1.8 2.8-3.7-1.3v-2.7a11 11 0 0 0-6 0v2.7l-3.7 1.3z',
} as const

export type IconName = keyof typeof PATHS

const FILLED = new Set<IconName>(['play', 'pause', 'more', 'threadCrumb', 'voiceChannel'])

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  const filled = FILLED.has(name)
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* A fixed 1.75px line at any rendered size, so small and large icons weigh the same. */}
      <path d={PATHS[name]} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
