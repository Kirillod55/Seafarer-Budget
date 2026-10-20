import { useEffect, useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { SYNC_TABLES } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { PARKED_PREFIX, type ParkedRow } from '../db/sync.ts'

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

const MAX_ERROR_CHARS = 80

/** The server could not be reached at all (as opposed to answering with an error). */
function isNetworkError(message: string): boolean {
  return /failed to fetch|fetch failed|network|load failed|timeout|timed out|aborted/i.test(message)
}

function short(message: string): string {
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…` : message
}

export function SyncBadge() {
  const { db, scheduler } = useApp()
  const status = useSyncExternalStore(scheduler.status$.subscribe, scheduler.status$.get)
  const online = useOnline()
  const counts = useLiveQuery(async () => {
    let pending = 0
    let parked = 0
    for (const t of SYNC_TABLES) {
      pending += await db.syncTable(t).where('dirty').equals(1).count()
      parked += await db.syncTable(t).where('dirty').equals(2).count()
    }
    const first = parked > 0 ? await db.meta.where('key').startsWith(PARKED_PREFIX).first() : undefined
    return { pending, parked, parkedError: (first?.value as ParkedRow | undefined)?.error ?? 'запись не принята сервером' }
  }, [db])
  const pending = counts?.pending ?? 0

  const failed = status.state === 'error' && status.error !== null
  const offline = !online || (failed && isNetworkError(status.error ?? ''))
  let text: string
  let kind: 'ok' | 'wait' | 'off' | 'err'
  if (offline) {
    text = pending > 0 ? `офлайн · ждёт отправки: ${pending}` : 'офлайн'
    kind = 'off'
  } else if (failed) {
    text = `ошибка: ${short(status.error ?? '')}`
    kind = 'err'
  } else if (counts && counts.parked > 0) {
    text = `ошибка: ${short(counts.parkedError)}`
    kind = 'err'
  } else if (pending > 0) {
    text = `⟳ ждёт отправки: ${pending}`
    kind = 'wait'
  } else if (status.state === 'syncing') {
    text = '⟳ синхронизация…'
    kind = 'wait'
  } else {
    text = '✓ синхронизировано'
    kind = 'ok'
  }

  return (
    <span className={`sync-badge sync-${kind}`} role="status" title={status.error ?? (counts?.parked ? counts.parkedError : undefined)}>
      {text}
    </span>
  )
}
