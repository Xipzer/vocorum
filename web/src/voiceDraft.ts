// Keep the original bytes until the hub acknowledges the message, not just the upload.
export type VoiceDraft = { key: string; blob: Blob; name: string; reply?: string; attachment?: string }
const memory = new Map<string, VoiceDraft>()
let opened: Promise<IDBDatabase> | undefined
function database() {
  return opened ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('vocorum-voice-drafts', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('drafts', { keyPath: 'key' })
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
  })
}
export async function loadVoice(key: string) {
  if (memory.has(key)) return memory.get(key)
  const db = await database()
  return new Promise<VoiceDraft | undefined>((resolve,reject) => {
    const r = db.transaction('drafts').objectStore('drafts').get(key)
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
  })
}
export async function saveVoice(key: string, d?: VoiceDraft) {
  if (d) memory.set(key,d); else memory.delete(key)
  const db = await database()
  await new Promise<void>((resolve,reject) => {
    const tx = db.transaction('drafts','readwrite'), store = tx.objectStore('drafts')
    if (d) store.put(d); else store.delete(key)
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
