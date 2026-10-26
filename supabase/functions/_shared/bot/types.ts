// Storage and transport contracts of the bot. No npm imports.
import type { Account, Category, FxRate, Goal, GoalMove, Limit, Settings, Transaction } from '../types.ts'

export interface BotStore {
  /** true if this update was already processed; otherwise remembers it and returns false */
  seenUpdate(updateId: number): Promise<boolean>
  settings(): Promise<Settings | null>
  /** live rows only: not deleted for good and (soft tables) not in the 24 h undo bin */
  categories(): Promise<Category[]>
  accounts(): Promise<Account[]>
  goals(): Promise<Goal[]>
  goalMoves(): Promise<GoalMove[]>
  limits(): Promise<Limit[]>
  transactions(): Promise<Transaction[]>
  /** known rates; fetches today's rate first when it is missing */
  rates(): Promise<FxRate[]>
  insertTx(t: Transaction): Promise<void>
  updateTx(id: string, patch: Partial<Transaction>): Promise<void>
  insertGoalMove(m: GoalMove): Promise<void>
  updateCategory(id: string, patch: Partial<Category>): Promise<void>
  /** Insert a row of the owner (the store sets `user_id`; `rev` is stamped by the database). */
  insert(table: WriteTable, row: object): Promise<void>
  /**
   * Patch a row of the owner. Restoring from the bin must send `base_rev` = the row's `rev`
   * (set_rev() keeps the deletion otherwise); use `restorePatch`.
   */
  update(table: WriteTable, id: string, patch: object): Promise<void>
  /**
   * Keep the AI draft shown under «Записать» with the update that produced it (bot_updates.draft),
   * so the button saves exactly what was shown (ruling 2026-10-26).
   */
  saveDraft(updateId: number, draft: object): Promise<void>
  /** Take the draft once: the draft, 'used' when already taken, null when there is none (or it was cleaned up). */
  takeDraft(updateId: number): Promise<unknown>
  /** Transactions in the 24 h undo bin (`deleted_at` set, not deleted for good). */
  binnedTransactions(): Promise<Transaction[]>
}

export type WriteTable = 'settings' | 'accounts' | 'categories' | 'transactions' | 'goals' | 'goal_moves' | 'limits'

export interface BotReply {
  method: 'sendMessage' | 'answerCallbackQuery' | 'editMessageText' | 'sendDocument'
  /** sendDocument: `document` is `{ filename, content }` (UTF-8 text); index.ts uploads it as multipart */
  payload: Record<string, unknown>
}

/** The patch that takes a row out of the undo bin: the server accepts it only with base_rev >= deleted_rev. */
export function restorePatch(row: { rev?: number }): { deleted_at: null; deleted_batch: null; base_rev: number | null } {
  return { deleted_at: null, deleted_batch: null, base_rev: row.rev ?? null }
}
