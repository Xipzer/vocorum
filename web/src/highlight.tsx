// Code colouring without a dependency: a small tokenizer for the languages agents
// actually paste (TS/JS, JSON, Python, shell, CSS, HTML, SQL, Rust, Go, YAML, TOML),
// Discord's ```ansi (terminal escape colours) and ```diff.

import type { ReactNode } from 'react'

type Kind = 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'prop' | 'op' | 'lit' | 'tag' | 'attr'
type Rule = [RegExp, Kind | ((m: RegExpExecArray) => Kind | null)]

const words = (list: string) => new RegExp(`\\b(?:${list.split(' ').join('|')})\\b`, 'y')

const C_LIKE_STR: Rule[] = [
  [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, 'com'],
  [/`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y, 'str'],
]
const NUM: Rule = [/\b(?:0x[\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?)\b/iy, 'num']
const CALL: Rule = [/\b[A-Za-z_$][\w$]*(?=\s*\()/y, 'fn']
const TYPE: Rule = [/\b[A-Z][\w$]*\b/y, 'type']

const LANGS: Record<string, Rule[]> = {
  ts: [
    ...C_LIKE_STR,
    [words('const let var function return if else for while do switch case break continue new class extends implements interface type enum import export from as async await yield try catch finally throw typeof instanceof in of keyof readonly public private protected static default declare namespace satisfies void delete'), 'kw'],
    [words('true false null undefined this super NaN Infinity'), 'lit'],
    NUM,
    CALL,
    TYPE,
  ],
  json: [[/"(?:\\.|[^"\\])*"(?=\s*:)/y, 'prop'], [/"(?:\\.|[^"\\])*"/y, 'str'], NUM, [words('true false null'), 'lit']],
  py: [
    [/#[^\n]*/y, 'com'],
    [/(?:[rbuf]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/iy, 'str'],
    [words('def class return if elif else for while in not and or is import from as with try except finally raise lambda yield pass break continue global nonlocal async await assert del'), 'kw'],
    [words('True False None self cls'), 'lit'],
    NUM,
    CALL,
    TYPE,
  ],
  sh: [
    [/#[^\n]*/y, 'com'],
    [/"(?:\\.|[^"\\])*"|'[^']*'/y, 'str'],
    [/\$\{[^}]*\}|\$[\w@#?$!*-]+/y, 'prop'],
    [words('if then else elif fi for in do done case esac while until function return export local readonly set unset source sudo cd echo exit'), 'kw'],
    [/(?<=^|[\s|;&(])--?[\w-]+/my, 'attr'],
    NUM,
  ],
  css: [[/\/\*[\s\S]*?\*\//y, 'com'], [/"[^"]*"|'[^']*'/y, 'str'], [/[.#][\w-]+(?=[^{}]*\{)/y, 'type'], [/[\w-]+(?=\s*:)/y, 'prop'], [/#[\da-f]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|ms|s|vh|vw|deg)?\b/iy, 'num'], [/@[\w-]+/y, 'kw']],
  html: [[/<!--[\s\S]*?-->/y, 'com'], [/<\/?[\w-]+/y, 'tag'], [/\b[\w-:]+(?==)/y, 'attr'], [/"[^"]*"|'[^']*'/y, 'str']],
  sql: [[/--[^\n]*/y, 'com'], [/'(?:''|[^'])*'/y, 'str'], [/\b(?:select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|index|on|join|left|right|inner|outer|group|by|order|limit|offset|as|distinct|having|union|all|primary|key|references|null|is|in|like|case|when|then|else|end|with|returning)\b/iy, 'kw'], NUM, CALL],
  rust: [...C_LIKE_STR, [words('fn let mut pub struct enum impl trait use mod crate self super match if else for while loop return as in where async await move ref const static dyn unsafe type'), 'kw'], [words('true false None Some Ok Err Self'), 'lit'], NUM, CALL, TYPE],
  go: [...C_LIKE_STR, [words('func package import var const type struct interface map chan go defer return if else for range switch case default break continue select'), 'kw'], [words('true false nil iota'), 'lit'], NUM, CALL, TYPE],
  yaml: [[/#[^\n]*/y, 'com'], [/^[ \t-]*[\w.-]+(?=\s*:)/my, 'prop'], [/"(?:\\.|[^"\\])*"|'[^']*'/y, 'str'], [words('true false null yes no'), 'lit'], NUM],
}
const ALIAS: Record<string, string> = { js: 'ts', jsx: 'ts', tsx: 'ts', javascript: 'ts', typescript: 'ts', mjs: 'ts', cjs: 'ts', python: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', jsonc: 'json', json5: 'json', scss: 'css', xml: 'html', svg: 'html', vue: 'html', rs: 'rust', golang: 'go', yml: 'yaml', toml: 'yaml', ini: 'yaml', postgres: 'sql', sqlite: 'sql' }

function tokenize(code: string, rules: Rule[]): ReactNode[] {
  const out: ReactNode[] = []
  let plain = ''
  let i = 0
  const flush = () => {
    if (plain) out.push(plain)
    plain = ''
  }
  outer: while (i < code.length) {
    for (const [re, kind] of rules) {
      re.lastIndex = i
      const m = re.exec(code)
      if (m && m[0].length) {
        const k = typeof kind === 'function' ? kind(m) : kind
        if (!k) continue
        flush()
        out.push(<span key={i} className={`tk-${k}`}>{m[0]}</span>)
        i += m[0].length
        continue outer
      }
    }
    plain += code[i]
    i++
    // Skip the rest of a plain word so keywords only match at word starts.
    const word = /^[\w$]+/.exec(code.slice(i, i + 64))
    if (/[\w$]/.test(code[i - 1]!) && word) {
      plain += word[0]
      i += word[0].length
    }
  }
  flush()
  return out
}

// ```ansi: SGR colours (30-37, 90-97), bold and underline, as Discord renders them.
const ANSI_COLOURS = ['#4f545c', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#ffffff']
function ansi(code: string): ReactNode[] {
  const out: ReactNode[] = []
  let style: { color?: string; fontWeight?: number; textDecoration?: string } = {}
  const parts = code.split(/\x1b\[([\d;]*)m|\u001b\[([\d;]*)m/)
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i]
    if (text) out.push(<span key={i} style={{ ...style }}>{text}</span>)
    const codes = (parts[i + 1] ?? parts[i + 2] ?? '').split(';').filter(Boolean).map(Number)
    for (const c of codes.length ? codes : parts[i + 1] !== undefined || parts[i + 2] !== undefined ? [0] : []) {
      if (c === 0) style = {}
      else if (c === 1) style = { ...style, fontWeight: 700 }
      else if (c === 4) style = { ...style, textDecoration: 'underline' }
      else if (c >= 30 && c <= 37) style = { ...style, color: ANSI_COLOURS[c - 30] }
      else if (c >= 90 && c <= 97) style = { ...style, color: ANSI_COLOURS[c - 90] }
      else if (c === 39) style = { ...style, color: undefined }
    }
  }
  return out
}

// ```diff: added lines green, removed red, hunk headers dim.
function diff(code: string): ReactNode[] {
  return code.split('\n').map((line, i) => {
    const kind = /^\+(?!\+\+)/.test(line) ? 'add' : /^-(?!--)/.test(line) ? 'del' : /^@@/.test(line) ? 'hunk' : 'ctx'
    return (
      <span key={i} className={`diff-line diff-${kind}`}>
        {line || ' '}
      </span>
    )
  })
}

// Markdown source styled the way JetBrains' editor shows a .md file: the text keeps every
// character (so copying gives back the exact markdown), markers are faint, and what they
// mean is drawn: headings bold, **bold** bold, *italic* italic, code tinted, links coloured,
// list markers in the accent, quotes muted, fenced code coloured by its language.
const MD_INLINE = /(`+)([^`\n]+?)\1|(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\3|(\*|_)(?=[^\s*_])([^\n*_]+?)(?<=\S)\5(?![\w*])|(~~)([^\n]+?)~~|(!?\[)([^\]\n]*)(\]\()([^)\s]*)(\))|(<https?:\/\/[^>\s]+>|https?:\/\/[^\s)>\]]+)|(<!--.*?-->|<\/?[a-z][^>\n]*>)/gi
function mdInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  const k = () => `${key}-${n++}`
  for (const m of text.matchAll(MD_INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    const [all, ticks, code, strong, strongText, em, emText, strike, strikeText, open, label, mid, url, close, bare, html] = m
    if (ticks) out.push(<span key={k()} className="md-code"><span className="md-mark">{ticks}</span>{code}<span className="md-mark">{ticks}</span></span>)
    else if (strong) out.push(<span key={k()} className="md-strong"><span className="md-mark">{strong}</span>{mdInline(strongText!, k())}<span className="md-mark">{strong}</span></span>)
    else if (em) out.push(<span key={k()} className="md-em"><span className="md-mark">{em}</span>{emText}<span className="md-mark">{em}</span></span>)
    else if (strike) out.push(<span key={k()} className="md-strike"><span className="md-mark">{strike}</span>{strikeText}<span className="md-mark">~~</span></span>)
    else if (open) out.push(<span key={k()}><span className="md-mark">{open}</span><span className="md-link">{label}</span><span className="md-mark">{mid}</span><span className="md-url">{url}</span><span className="md-mark">{close}</span></span>)
    else if (bare) out.push(<span key={k()} className="md-url">{bare}</span>)
    else if (html) out.push(<span key={k()} className="md-mark">{html}</span>)
    else out.push(all)
    last = m.index! + all.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function markdownSource(code: string): ReactNode[] {
  const lines = code.split('\n')
  const out: ReactNode[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const key = `l${i}`
    const nl = i < lines.length - 1 ? '\n' : ''
    const fence = /^(\s*)(```|~~~)(\S*)/.exec(line)
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && l.trimStart().startsWith(fence[2]!))
      const stop = end === -1 ? lines.length : end
      const inner = lines.slice(i + 1, stop).join('\n')
      out.push(<span key={key} className="md-mark">{line}{'\n'}</span>)
      if (stop > i + 1) out.push(<span key={`${key}c`} className="md-block">{highlight(fence[3] ?? '', inner)}{'\n'}</span>)
      if (end !== -1) out.push(<span key={`${key}e`} className="md-mark">{lines[end]}{end < lines.length - 1 ? '\n' : ''}</span>)
      i = stop
      continue
    }
    const heading = /^(#{1,6})(\s+)(.*)$/.exec(line)
    if (heading) {
      out.push(<span key={key} className={`md-h md-h${heading[1]!.length}`}><span className="md-mark">{heading[1]}</span>{heading[2]}{mdInline(heading[3]!, key)}{nl}</span>)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')) {
      out.push(<span key={key} className="md-mark">{line}{nl}</span>)
      continue
    }
    const quote = /^(\s*(?:>\s?)+)(.*)$/.exec(line)
    if (quote) {
      out.push(<span key={key} className="md-quote"><span className="md-bar">{quote[1]}</span>{mdInline(quote[2]!, key)}{nl}</span>)
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?(.*)$/.exec(line)
    if (item) {
      out.push(<span key={key}>{item[1]}<span className="md-bullet">{item[2]}</span>{item[3]}{item[4] && <span className="md-bullet">{item[4]}</span>}{mdInline(item[5]!, key)}{nl}</span>)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const head = /^\s*\|?[\s:|-]+\|/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')
      out.push(<span key={key} className={head ? 'md-strong' : undefined}>{line.split(/(\|)/).map((part, j) => (part === '|' ? <span key={j} className="md-mark">|</span> : <span key={j}>{mdInline(part, `${key}-${j}`)}</span>))}{nl}</span>)
      continue
    }
    out.push(<span key={key}>{mdInline(line, key)}{nl}</span>)
  }
  return out
}

export function highlight(lang: string, code: string): ReactNode {
  const l = lang.toLowerCase()
  if (l === 'md' || l === 'markdown' || l === 'mdx') return markdownSource(code)
  if (l === 'ansi' || /\x1b\[/.test(code)) return ansi(code)
  if (l === 'diff' || l === 'patch') return diff(code)
  const rules = LANGS[ALIAS[l] ?? l]
  if (!rules || code.length > 60_000) return code
  return tokenize(code, rules)
}
