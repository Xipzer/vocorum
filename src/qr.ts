// QR codes for pairing links, printed in the terminal so a phone can scan
// them. Byte mode, error correction level M, versions 1 to 10 (up to 213
// bytes), written from ISO/IEC 18004. No dependency.

const ECC_M: Array<[number, number]> = [[10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]]
const TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

// GF(256) with the QR polynomial 0x11D.
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0)

function reedSolomon(data: number[], degree: number): number[] {
  // Generator: product of (x - a^i) for i < degree, highest coefficient first (implicit 1).
  let gen = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]!
      next[j + 1] ^= mul(gen[j]!, EXP[i]!)
    }
    gen = next
  }
  const rem = new Array(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem.shift()
    rem.push(0)
    for (let j = 0; j < degree; j++) rem[j] ^= mul(gen[j + 1]!, factor)
  }
  return rem
}

function codewords(bytes: Uint8Array, version: number): number[] {
  const [ecc, blocks] = ECC_M[version - 1]!
  const dataLength = TOTAL[version - 1]! - ecc * blocks
  const bits: number[] = []
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, dataLength * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  for (let pad = 0xec; data.length < dataLength; pad ^= 0xec ^ 0x11) data.push(pad)
  // Split into blocks (the short ones first), add error correction, interleave.
  const total = TOTAL[version - 1]!
  const short = blocks - (total % blocks)
  const shortData = Math.floor(total / blocks) - ecc
  const dataBlocks: number[][] = []
  const eccBlocks: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const length = shortData + (i < short ? 0 : 1)
    const block = data.slice(k, k + length)
    k += length
    dataBlocks.push(block)
    eccBlocks.push(reedSolomon(block, ecc))
  }
  const out: number[] = []
  for (let i = 0; i <= shortData; i++) for (const block of dataBlocks) if (i < block.length) out.push(block[i]!)
  for (let i = 0; i < ecc; i++) for (const block of eccBlocks) out.push(block[i]!)
  return out
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function bch(value: number, poly: number, bits: number) {
  const degree = Math.floor(Math.log2(poly))
  let rem = value << degree
  for (let i = bits - 1; i >= 0; i--) if ((rem >>> (i + degree)) & 1) rem ^= poly << i
  return rem
}

export type QrMatrix = boolean[][]

// Returns rows of modules (true = dark), without the quiet zone.
export function qrMatrix(text: string, { mask: forcedMask }: { mask?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  const version = TOTAL.findIndex((total, i) => (total - ECC_M[i]![0] * ECC_M[i]![1]) * 8 >= 4 + (i < 9 ? 8 : 16) + bytes.length * 8) + 1
  if (version === 0) throw new Error('Text too long for a QR code here')
  const size = version * 4 + 17
  const dark: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false))
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x: number, y: number, value: boolean) => {
    dark[y]![x] = value
    fixed[y]![x] = true
  }
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        set(x, y, d !== 2 && d !== 4)
      }
  }
  const align = ALIGN[version - 1]!
  for (const ax of align)
    for (const ay of align) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === align.at(-1)) || (ax === align.at(-1) && ay === 6)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  const formatBits = (mask: number) => {
    const data = (0b00 << 3) | mask // level M
    const bits = ((data << 10) | bch(data, 0x537, 5)) ^ 0x5412
    const bit = (i: number) => ((bits >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  formatBits(0)
  if (version >= 7) {
    const bits = (version << 12) | bch(version, 0x1f25, 6)
    for (let i = 0; i < 18; i++) {
      const value = ((bits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, value)
      set(b, a, value)
    }
  }
  // Data, in two-column zigzags from the bottom right, skipping the timing column.
  const words = codewords(bytes, version)
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (fixed[y]![x]) continue
        if (index < words.length * 8) dark[y]![x] = ((words[index >>> 3]! >>> (7 - (index & 7))) & 1) === 1
        index++
      }
  }
  const apply = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y]![x] && MASKS[mask]!(x, y)) dark[y]![x] = !dark[y]![x]
    formatBits(mask)
  }
  let best = forcedMask ?? 0
  if (forcedMask === undefined) {
    let lowest = Infinity
    for (let mask = 0; mask < 8; mask++) {
      apply(mask)
      const score = penalty(dark)
      if (score < lowest) {
        lowest = score
        best = mask
      }
      apply(mask) // undo (XOR again)
    }
  }
  apply(best)
  return dark
}

function penalty(m: QrMatrix): number {
  const size = m.length
  let score = 0
  const line = (get: (i: number) => boolean) => {
    let run = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++
      else {
        if (run >= 5) score += run - 2
        run = 1
      }
    }
    // Finder-like 1:1:3:1:1 with four light modules on one side (off the edge counts as light).
    const at = (i: number) => i >= 0 && i < size && get(i)
    for (let i = -4; i < size; i++) {
      const core = [1, 0, 1, 1, 1, 0, 1].every((v, k) => at(i + k) === Boolean(v))
      if (!core) continue
      const before = [1, 2, 3, 4].every((k) => !at(i - k))
      const after = [7, 8, 9, 10].every((k) => !at(i + k))
      if (before || after) score += 40
    }
  }
  for (let y = 0; y < size; y++) line((x) => m[y]![x]!)
  for (let x = 0; x < size; x++) line((y) => m[y]![x]!)
  let darkCount = 0
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (m[y]![x]) darkCount++
      if (x < size - 1 && y < size - 1 && m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) score += 3
    }
  score += Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size)) * 10
  return score
}

// Two rows per character with half blocks, black on white with a quiet zone,
// so it scans on dark and light terminals alike.
export function qrTerminal(text: string): string {
  const m = qrMatrix(text)
  const quiet = 2
  const size = m.length + quiet * 2
  const at = (x: number, y: number) => x >= quiet && y >= quiet && x < size - quiet && y < size - quiet && m[y - quiet]![x - quiet]!
  const rows: string[] = []
  for (let y = 0; y < size; y += 2) {
    let row = '\x1b[30;47m'
    for (let x = 0; x < size; x++) {
      const top = at(x, y)
      const bottom = y + 1 < size && at(x, y + 1)
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    rows.push(`${row}\x1b[0m`)
  }
  return rows.join('\n')
}
