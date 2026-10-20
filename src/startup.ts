import type { LocalDb } from './db/local.ts'

export type StartupState = 'ready' | 'wizard' | 'need_internet'

async function hasSettings(db: LocalDb): Promise<boolean> {
  return (await db.settings.filter((s) => !s.deleted).count()) > 0
}

/**
 * What to show right after login (R18).
 * - Settings already stored locally: ready at once (sync keeps running in the background).
 * - Otherwise sync first: settings pulled -> ready; still absent after a SUCCESSFUL sync -> wizard;
 *   the sync failed (offline) -> «Нужен интернет для первого запуска».
 */
export async function resolveStartup(
  db: LocalDb,
  syncOnce: () => Promise<unknown>,
): Promise<StartupState> {
  if (await hasSettings(db)) return 'ready'

  let failed = false
  try {
    const res = await syncOnce()
    failed = Boolean((res as { error?: string } | undefined)?.error)
  } catch {
    failed = true
  }

  if (await hasSettings(db)) return 'ready'
  return failed ? 'need_internet' : 'wizard'
}
