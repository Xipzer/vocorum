// The hub's own database on Node's built-in SQLite (node:sqlite), with the
// small part of @libsql/client's interface the hub uses: execute, batch and
// close. @libsql/client keeps native memory for every statement it runs
// (about 2 KB each, never freed), so a busy hub grew without bound.

import { DatabaseSync, type StatementSync } from 'node:sqlite'

export type InValue = null | string | number | bigint | boolean | Uint8Array | ArrayBuffer | Date
export type InStatement = string | { sql: string; args?: InValue[] }
export type Row = Record<string, unknown>
export type ResultSet = { rows: Row[]; rowsAffected: number; lastInsertRowid: bigint | undefined }

const CACHE = 300

function bind(value: InValue): null | string | number | bigint | Uint8Array {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return value
}

export class SqliteDb {
  private db: DatabaseSync
  private statements = new Map<string, StatementSync>()

  constructor(file: string) {
    this.db = new DatabaseSync(file)
  }

  private prepare(sql: string) {
    let statement = this.statements.get(sql)
    if (statement) {
      // Most recently used last.
      this.statements.delete(sql)
      this.statements.set(sql, statement)
      return statement
    }
    statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    if (this.statements.size > CACHE) this.statements.delete(this.statements.keys().next().value!)
    return statement
  }

  private run(input: InStatement): ResultSet {
    const { sql, args = [] } = typeof input === 'string' ? { sql: input, args: [] } : input
    const statement = this.prepare(sql)
    const values = args.map(bind)
    if (statement.columns().length > 0) return { rows: statement.all(...values) as Row[], rowsAffected: 0, lastInsertRowid: undefined }
    const result = statement.run(...values)
    return { rows: [], rowsAffected: Number(result.changes), lastInsertRowid: BigInt(result.lastInsertRowid) }
  }

  async execute(input: InStatement): Promise<ResultSet> {
    return this.run(input)
  }

  // All statements in one transaction ('write' takes the write lock at once).
  async batch(statements: InStatement[], mode: 'write' | 'read' | 'deferred' = 'deferred'): Promise<ResultSet[]> {
    this.db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
      const results = statements.map((s) => this.run(s))
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.statements.clear()
    if (this.db.isOpen) this.db.close()
  }
}

// file:/path or a plain path.
export function openSqlite(url: string) {
  return new SqliteDb(url.replace(/^file:/, ''))
}
