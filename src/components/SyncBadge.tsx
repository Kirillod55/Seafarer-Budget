import { useEffect, useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { SYNC_TABLES } from '@shared/types.ts'
import { useApp } from '../context.tsx'

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

export function SyncBadge() {
  const { db, scheduler } = useApp()
  const status = useSyncExternalStore(scheduler.status$.subscribe, scheduler.status$.get)
  const online = useOnline()
  const pending =
    useLiveQuery(async () => {
      let n = 0
      for (const t of SYNC_TABLES) n += await db.syncTable(t).where('dirty').equals(1).count()
      return n
    }, [db]) ?? 0

  const offline = !online || status.state === 'error'
  let text: string
  let kind: 'ok' | 'wait' | 'off'
  if (offline) {
    text = pending > 0 ? `офлайн · ждёт отправки: ${pending}` : 'офлайн'
    kind = 'off'
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
    <span className={`sync-badge sync-${kind}`} role="status" title={status.error ?? undefined}>
      {text}
    </span>
  )
}
