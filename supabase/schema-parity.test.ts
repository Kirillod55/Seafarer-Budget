// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Keeps supabase/functions/_shared/types.ts and the SQL migrations in step: every field of a synced
// interface must be a column of its table. The field lists are written out here on purpose (not
// imported) so that changing a type without the migration, or the reverse, fails this test.

const BASE = ['id', 'user_id', 'rev', 'deleted', 'base_rev']
const SOFT_DELETE = ['deleted_at', 'deleted_batch']

const FIELDS: Record<string, string[]> = {
  settings: [
    ...BASE,
    'base_currency', 'default_currency', 'currencies', 'accounts_mode', 'status',
    'next_contract_date', 'contract_start_date', 'contract_end_date', 'salary_lag_days', 'timezone',
    'reserve_usd', 'partner_name', 'partner_seen_at', 'remind_after_days', 'last_reminder_at',
    'keepalive_at', 'daily_summary_owner', 'daily_summary_partner',
  ],
  accounts: [...BASE, 'name', 'aliases', 'is_default', 'archived', 'sort'],
  categories: [...BASE, ...SOFT_DELETE, 'name', 'kind', 'icon', 'keywords', 'archived', 'sort', 'color', 'glyph'],
  transactions: [
    ...BASE, ...SOFT_DELETE,
    'kind', 'amount', 'currency', 'rate_usd', 'amount_usd', 'rate_pending', 'account_id', 'to_account_id',
    'to_amount', 'to_currency', 'category_id', 'date', 'note', 'source', 'created_at', 'author', 'archived',
  ],
  goals: [...BASE, ...SOFT_DELETE, 'name', 'target_usd', 'deadline', 'archived'],
  goal_moves: [...BASE, 'goal_id', 'amount_usd', 'date', 'note', 'author', 'source', 'created_at'],
  limits: [...BASE, ...SOFT_DELETE, 'category_id', 'monthly_usd'],
}

const dir = join(__dirname, 'migrations')
const sql = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, ''))
  .join('\n')

/** First word of each column definition in a comma-separated list (commas inside parentheses ignored). */
function columnNames(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts.map((p) => p.trim().match(/^"?([a-z_][a-z0-9_]*)"?\s/i)?.[1]).filter((x): x is string => !!x)
}

function sqlColumns(): Record<string, Set<string>> {
  const cols: Record<string, Set<string>> = {}
  const add = (t: string, names: string[]) => {
    cols[t] ??= new Set()
    for (const n of names) cols[t].add(n)
  }

  // create table public.x ( ... );
  for (const m of sql.matchAll(/create\s+table\s+public\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    add(m[1], columnNames(m[2]).filter((n) => !/^(primary|constraint|unique|check|foreign)$/i.test(n)))
  }

  // alter table public.x add column a ..., add column b ...;
  for (const m of sql.matchAll(/alter\s+table\s+public\.(\w+)((?:\s+add\s+column[^;]*?)+);/gi)) {
    add(m[1], [...m[2].matchAll(/add\s+column\s+(\w+)/gi)].map((c) => c[1]))
  }

  // DO blocks: foreach t in array array['a', 'b'] loop execute format('alter table public.%I add column x ..., add column y', t);
  for (const m of sql.matchAll(
    /foreach\s+t\s+in\s+array\s+array\[([^\]]*)\]\s*loop\s*execute\s+format\(\s*'alter\s+table\s+public\.%I\s+([^']*)'/gi,
  )) {
    const tables = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1])
    const added = [...m[2].matchAll(/add\s+column\s+(\w+)/gi)].map((c) => c[1])
    for (const t of tables) add(t, added)
  }
  return cols
}

describe('types.ts and SQL migrations agree', () => {
  const cols = sqlColumns()

  it('the parser found the synced tables', () => {
    expect(Object.keys(cols).sort()).toEqual(expect.arrayContaining(Object.keys(FIELDS)))
    expect(cols.transactions.has('author')).toBe(true)
    expect(cols.limits.has('base_rev')).toBe(true)
  })

  for (const [table, fields] of Object.entries(FIELDS)) {
    it(`every ${table} field is a column`, () => {
      const missing = fields.filter((f) => !cols[table]?.has(f))
      expect(missing).toEqual([])
    })
  }
})
