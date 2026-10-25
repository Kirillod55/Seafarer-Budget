/** A row is alive unless it was deleted for good (`deleted`) or sits in the 24 h undo bin (`deleted_at`). 1.0 rows have no `deleted_at`. */
export function alive(row: { deleted: boolean; deleted_at?: string | null }): boolean {
  return !row.deleted && (row.deleted_at ?? null) === null
}

export function liveRows<T extends { deleted: boolean; deleted_at?: string | null }>(rows: T[]): T[] {
  return rows.filter(alive)
}
