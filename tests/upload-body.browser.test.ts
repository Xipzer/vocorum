// The Mac app's web view delivers a form that holds a file to the app as an empty body,
// so the client must send every form as bytes with the boundary from the same encoder.

import { expect, test, vi } from 'vitest'

test('an upload leaves the client as bytes with its own boundary, never as a form', async () => {
  const sent: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    return new Response(JSON.stringify({ id: '1' }), { headers: { 'content-type': 'application/json' } })
  })
  const { api } = await import('../web/src/api.ts')
  for (const voice of [undefined, { durationSecs: 2, waveform: 'AAAA' }]) {
    sent.length = 0
    await api.upload(new Blob(['abc'], { type: 'audio/webm' }), 'note.webm', voice)
    const { url, init } = sent[0]!
    expect(url).toBe('/client/uploads')
    expect(init.body).toBeInstanceOf(ArrayBuffer)
    const type = new Headers(init.headers).get('content-type')!
    expect(type).toMatch(/^multipart\/form-data; boundary=/)
    const form = await new Response(init.body as ArrayBuffer, { headers: { 'content-type': type } }).formData()
    expect((form.get('file') as File).size).toBe(3)
    expect(form.get('voice')).toBe(voice ? '1' : null)
  }
  vi.unstubAllGlobals()
})
