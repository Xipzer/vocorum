// The source supplies the start; the hub supplies the observation time. Changing
// the device clock, navigating or remounting a row cannot change either of them.
type Timed = { runStartedAt?: number | null }
let samples = new WeakMap<Timed, { age: number; received: number }>()

export function sampleRun<T extends Timed>(s: T, serverTime: unknown): T {
  const start = s.runStartedAt
  if (
    typeof start === 'number' &&
    Number.isSafeInteger(start) &&
    start > 0 &&
    typeof serverTime === 'number' &&
    Number.isSafeInteger(serverTime) &&
    serverTime >= start
  ) {
    samples.set(s, { age: serverTime - start, received: performance.now() })
  } else samples.delete(s)
  return s
}

export function elapsedRun(s: Timed | undefined) {
  const sample = s && samples.get(s)
  return sample ? sample.age + Math.max(0, performance.now() - sample.received) : null
}

export function forgetRunClocks() {
  samples = new WeakMap()
}
