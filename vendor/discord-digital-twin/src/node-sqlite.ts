// Prisma on Node's built-in SQLite (node:sqlite) instead of @libsql/client,
// which keeps native memory for every statement it runs (several KB each,
// never freed): a busy server grew by hundreds of MB a day.
//
// Prisma's libsql adapter only needs a client with execute, transaction,
// executeMultiple and close, so this gives it one over node:sqlite and reuses
// the adapter's type mapping and error handling as they are.

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { PrismaLibSql } from '@prisma/adapter-libsql'

type Value = null | string | number | bigint | boolean | Uint8Array | ArrayBuffer | Date
type Statement = string | { sql: string; args?: Value[] }
type Result = { columns: string[]; columnTypes: string[]; rows: unknown[][]; rowsAffected: number; lastInsertRowid: bigint | undefined }

// One connection per database within a process, shared by every client of it:
// in-memory databases are shared like libsql's cache=shared, and two
// connections never fight over locks.
const open = new Map<string, { db: DatabaseSync; users: number; statements: Map<string, StatementSync> }>()
const CACHE = 300

function connection(url: string) {
  const memory = url.includes(':memory:')
  const file = memory ? ':memory:' : url.replace(/^file:/, '').replace(/\?.*$/, '')
  const key = memory ? url : file
  let entry = open.get(key)
  if (!entry) {
    entry = { db: new DatabaseSync(file), users: 0, statements: new Map() }
    open.set(key, entry)
  }
  entry.users++
  return { key, entry }
}

function bind(value: Value): null | string | number | bigint | Uint8Array {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value === undefined) return null
  return value
}

// libsql hands blobs back as ArrayBuffer; the adapter expects that.
function unbind(value: unknown) {
  return value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value
}

class NodeSqliteClient {
  private readonly key: string
  private readonly entry: { db: DatabaseSync; users: number; statements: Map<string, StatementSync> }
  private closed = false

  constructor(url: string) {
    ;({ key: this.key, entry: this.entry } = connection(url))
  }

  private prepare(sql: string) {
    const cache = this.entry.statements
    let statement = cache.get(sql)
    if (statement) {
      cache.delete(sql)
      cache.set(sql, statement)
      return statement
    }
    statement = this.entry.db.prepare(sql)
    statement.setReturnArrays(true)
    cache.set(sql, statement)
    if (cache.size > CACHE) cache.delete(cache.keys().next().value!)
    return statement
  }

  run(input: Statement): Result {
    const { sql, args = [] } = typeof input === 'string' ? { sql: input, args: [] } : input
    try {
      const statement = this.prepare(sql)
      const values = args.map(bind)
      const described = statement.columns()
      if (described.length > 0) {
        const rows = (statement.all(...values) as unknown as unknown[][]).map((row) => row.map(unbind))
        return { columns: described.map((c) => c.name), columnTypes: described.map((c) => c.type ?? ''), rows, rowsAffected: 0, lastInsertRowid: undefined }
      }
      const done = statement.run(...values)
      return { columns: [], columnTypes: [], rows: [], rowsAffected: Number(done.changes), lastInsertRowid: BigInt(done.lastInsertRowid) }
    } catch (error) {
      throw driverError(error)
    }
  }

  async execute(input: Statement) {
    return this.run(input)
  }

  async executeMultiple(script: string) {
    try {
      this.entry.db.exec(script)
    } catch (error) {
      throw driverError(error)
    }
  }

  async batch(statements: Statement[]) {
    const tx = await this.transaction('write')
    try {
      const results = statements.map((s) => tx.run(s))
      await tx.commit()
      return results
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }

  // The adapter serialises everything on this client while a transaction is open.
  async transaction(mode: 'deferred' | 'write' | 'read' = 'deferred') {
    this.entry.db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED')
    const db = this.entry.db
    const run = (s: Statement) => this.run(s)
    return {
      run,
      execute: async (s: Statement) => run(s),
      commit: async () => {
        if (db.isTransaction) db.exec('COMMIT')
      },
      rollback: async () => {
        if (db.isTransaction) db.exec('ROLLBACK')
      },
      close: () => {
        if (db.isTransaction) db.exec('ROLLBACK')
      },
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (--this.entry.users > 0) return
    open.delete(this.key)
    this.entry.statements.clear()
    if (this.entry.db.isOpen) this.entry.db.close()
  }
}

// Shaped like libsql's errors, so the adapter maps constraint violations the same way.
function driverError(error: unknown) {
  const e = error as { message?: string; errcode?: number; code?: string }
  const rawCode = typeof e.errcode === 'number' ? e.errcode : undefined
  return Object.assign(new Error(e.message ?? String(error)), { code: `SQLITE_${rawCode ?? 'ERROR'}`, rawCode })
}

export class PrismaNodeSqlite extends PrismaLibSql {
  createClient(config: { url: string }) {
    return new NodeSqliteClient(config.url) as never
  }
}
