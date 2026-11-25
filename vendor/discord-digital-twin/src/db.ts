// Prisma client on Node's built-in SQLite (see node-sqlite.ts).
// Vitest runs each test file in a separate worker thread, so all
// instances within the same file share the same in-memory database
// and cross-file isolation comes from separate processes/threads.

import { PrismaNodeSqlite } from './node-sqlite.js'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

export function createPrismaClient(dbUrl?: string): PrismaClient {
  // One shared in-memory database by default; pass a file: URL (e.g.
  // "file:./test.db") for persistent/debuggable storage.
  const url = dbUrl ?? 'file::memory:?cache=shared'
  const adapter = new PrismaNodeSqlite({ url })
  return new PrismaClient({ adapter })
}
