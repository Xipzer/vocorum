import { expect, test, vi } from 'vitest'
import { elapsedRun, forgetRunClocks, sampleRun } from '../web/src/run-clock.ts'

test('clock survives navigation and device wall-clock skew, but never guesses a missing start or continues offline', () => {
  const mono = vi.spyOn(performance, 'now').mockReturnValue(200)
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
  const time = 1_800_000_000_000
  try {
    const original = sampleRun({ runStartedAt: time }, time + 71_000)
    const other = sampleRun({ runStartedAt: null }, time + 72_000)
    wall.mockReturnValue(1_600_000_000_000)
    mono.mockReturnValue(2200)
    expect(elapsedRun(other)).toBeNull()
    expect(elapsedRun(original)).toBe(73_000)
    forgetRunClocks()
    expect(elapsedRun(original)).toBeNull()
    expect(elapsedRun(sampleRun({ ...original }, undefined))).toBeNull()
    expect(elapsedRun(sampleRun({ ...original }, time - 1))).toBeNull()
    expect(elapsedRun(sampleRun({ ...original }, time + 86_000))).toBe(86_000)
  } finally {
    forgetRunClocks()
    vi.restoreAllMocks()
  }
})
