// Host-side differences between Linux, macOS and Windows that can be checked anywhere.

import { expect, test } from 'vitest'
import { nodeSupported, tool } from '../src/platform.ts'

test('Node 22.16 or newer (node:sqlite with statement.columns)', () => {
  expect(nodeSupported('22.14.0')).toBe(false)
  expect(nodeSupported('22.16.0')).toBe(true)
  expect(nodeSupported('23.1.0')).toBe(true)
  expect(nodeSupported('24.22.2')).toBe(true)
  expect(nodeSupported('20.19.0')).toBe(false)
})

test('tools resolve to a path on PATH, or to their name', () => {
  expect(tool('openssl')).toMatch(/openssl/)
  expect(tool('tailscale')).toMatch(/tailscale/i)
})
