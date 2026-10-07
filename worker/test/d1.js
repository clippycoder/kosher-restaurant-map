/**
 * Just enough of the D1 binding, over node:sqlite, to run the worker in tests
 * without wrangler. Covers prepare/bind/first/all/run as the worker uses them.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function createD1(migrationsDir) {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(path.join(migrationsDir, f), 'utf8'));
  }

  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a.map((v) => (v === undefined ? null : v))),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
    },
  });

  return { prepare: (sql) => statement(sql), raw: db };
}
