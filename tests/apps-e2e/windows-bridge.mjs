// Runs on Windows (node.exe): evaluates expressions in the app's WebView2 over
// its debugging port. One JSON request per stdin line, one JSON answer per
// stdout line: {id, expression} -> {id, value} or {id, error}.
//   node windows-bridge.mjs <port>

import readline from 'node:readline'

const port = Number(process.argv[2])
let socket = null
let next = 0
const pending = new Map()

async function connect() {
  if (socket?.readyState === WebSocket.OPEN) return socket
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page yet')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('could not connect to the page'))
  })
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  }
  socket.onclose = () => (socket = null)
  return socket
}

async function evaluate(expression) {
  const ws = await connect()
  const id = ++next
  const answer = new Promise((resolve) => pending.set(id, resolve))
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true } }))
  const m = await Promise.race([answer, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 20_000))])
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'exception')
  return m.result?.result?.value
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, expression } = JSON.parse(line)
  try {
    process.stdout.write(JSON.stringify({ id, value: await evaluate(expression) }) + '\n')
  } catch (e) {
    socket = null
    process.stdout.write(JSON.stringify({ id, error: String(e?.message ?? e) }) + '\n')
  }
}
