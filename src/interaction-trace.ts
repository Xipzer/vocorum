// Local journal only. Whitelist fields: interaction tokens, input values, user
// messages and private results must never be included in diagnostics.
export function traceInteraction(phase: 'dispatched' | 'acknowledged' | 'no-ack' | 'published' | 'edited', id: string, fields: { channel?: string; command?: string; kind?: string; responseType?: number | null; elapsedMs?: number; message?: string; recipients?: number; private?: boolean }) {
  const write = phase === 'no-ack' ? console.warn : console.info
  write('[interaction]', JSON.stringify({ phase, id, ...fields }))
}
