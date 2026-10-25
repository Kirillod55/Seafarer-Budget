// «Удаление данных» and the 24 h undo bin. Pure code shared by the app and the bot (/clear).
import { alive } from './alive.ts'
import { addDays } from './dates.ts'
import type { SoftDeletable, Transaction } from './types.ts'

export type WipeScope = 'day' | 'week' | 'month' | 'all'
export type WipeKind = 'expense' | 'income' | 'all'

/** How long a soft-deleted row can be brought back. */
export const RESTORE_MS = 24 * 60 * 60 * 1000

const SPAN: Record<Exclude<WipeScope, 'all'>, number> = { day: 1, week: 7, month: 30 }

/** First date of the period (inclusive): day → today, week → the last 7 days, month → the last 30; all → no bound. */
export function wipeFrom(scope: WipeScope, today: string): string | null {
  return scope === 'all' ? null : addDays(today, 1 - SPAN[scope])
}

/** Live transactions of the kind dated in [wipeFrom, today]; future dates are never touched. */
export function selectForWipe<T extends Transaction>(txs: T[], scope: WipeScope, kind: WipeKind, today: string): T[] {
  const from = wipeFrom(scope, today)
  return txs.filter(
    (t) =>
      alive(t) &&
      (kind === 'all' || t.kind === kind) &&
      t.date <= today &&
      (from === null || t.date >= from),
  )
}

const age = (deletedAt: string, nowMs: number) => nowMs - Date.parse(deletedAt)

/** The batch still has rows in the bin and 24 h have not passed since they went there. */
export function restorable(rows: SoftDeletable[], batch: string, nowMs: number): boolean {
  return rows.some((r) => r.deleted_batch === batch && r.deleted_at !== null && age(r.deleted_at, nowMs) <= RESTORE_MS)
}

/** Ids of rows that sat in the bin longer than 24 h: due for the final deletion (`deleted = true`). */
export function purgeDue(rows: (SoftDeletable & { id: string; deleted: boolean })[], nowMs: number): string[] {
  return rows.filter((r) => !r.deleted && r.deleted_at !== null && age(r.deleted_at, nowMs) > RESTORE_MS).map((r) => r.id)
}
