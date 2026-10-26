import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { SYNC_TABLES } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { useDesk } from '../desk/layout.ts'
import { useScreenActive } from '../nav/Navigator.tsx'
import { useToast } from '../ui/Toast.tsx'
import { PARKED_PREFIX, type ParkedRow } from '../db/sync.ts'
import './sync-cloud.css'

/** navigator.onLine, kept up to date by the online / offline events. */
export function useOnline(): boolean {
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

/** The server could not be reached at all (as opposed to answering with an error). */
export function isNetworkError(message: string): boolean {
  return /failed to fetch|fetch failed|network|load failed|timeout|timed out|aborted/i.test(message)
}

export type CloudState = 'ok' | 'err' | 'off' | 'sync'

/** rows cleared this soon after a sync finished still count as «just synced» */
const POP_WINDOW_MS = 1000

// The prototype's cloud (prototype v60 CLOUD / cloudIcon): an open cloud with a badge in its lower right corner.
const CLOUD =
  'M11 18H6.66C4.08 18 2 15.99 2 13.52c0-2.48 2.09-4.49 4.66-4.49.39-1.76 1.79-3.2 3.67-3.77 1.88-.57 3.96-.19 5.45 1 1.49 1.19 2.16 3.01 1.77 4.77h.99c1.38 0 2.57.81 3.13 1.99'
const ARROWS = [
  'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
  'M21 3v5h-5',
  'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
  'M8 16H3v5',
]

/*
 * The sync cloud in the home header (spec §3 item 1, §6 «Облачко синхронизации — три состояния»): an indicator,
 * not a button — no glass, opens nothing. Synced: a tick in --accent-text; an error: a red cross; no network or
 * records waiting to be sent: a grey cloud with an arrow up. While a sync runs two arrows spin (0.9 s a turn);
 * the badges swap with a spring and the tick «pops» in after a sync.
 */
export function SyncCloud() {
  const { db, scheduler } = useApp()
  const status = useSyncExternalStore(scheduler.status$.subscribe, scheduler.status$.get)
  const online = useOnline()
  const desk = useDesk()
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
  let state: CloudState
  let label: string
  if (offline) {
    state = 'off'
    label = pending > 0 ? `Нет сети · ждёт отправки: ${pending}` : 'Нет сети'
  } else if (status.state === 'syncing') {
    state = 'sync'
    label = 'Синхронизация…'
  } else if (failed) {
    state = 'err'
    label = `Синхронизация не удалась: ${status.error}`
  } else if (counts && counts.parked > 0) {
    state = 'err'
    label = `Синхронизация не удалась: ${counts.parkedError}`
  } else if (pending > 0) {
    state = 'off'
    label = `Ждёт отправки: ${pending}`
  } else {
    state = 'ok'
    label = 'Синхронизировано'
  }

  // the tick pops in when a sync has just finished
  // The tick pops when a sync has just finished: the scheduler went syncing → idle within the last second. The
  // pending count may still be stale for a moment (grey «waiting»), so the pop waits for the cloud to turn ok.
  const [lastRun, setLastRun] = useState(status.state)
  const [syncedAt, setSyncedAt] = useState(0)
  if (lastRun !== status.state) {
    setLastRun(status.state)
    if (lastRun === 'syncing' && status.state === 'idle') setSyncedAt(Date.now())
  }
  const [last, setLast] = useState(state)
  const [pop, setPop] = useState(false)
  if (last !== state) {
    setLast(state)
    setPop(state === 'ok' && (last === 'sync' || Date.now() - syncedAt < POP_WINDOW_MS))
  }

  const cls = `syncind ${state}${state === 'sync' ? ' syncing' : ''}${pop ? ' pop' : ''}`
  const icon = <CloudIcon />
  if (desk) {
    return (
      <DeskCloud cls={cls} label={label} state={state} lastSyncAt={status.lastSyncAt}>
        {icon}
      </DeskCloud>
    )
  }
  return (
    <span className={cls} role="img" aria-label={label} title={label} data-state={state}>
      {icon}
    </span>
  )
}

function CloudIcon() {
  return (
    <>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={CLOUD} />
        <g className="bd b-ok">
          <path d="M15 19l2 2 4-4" />
        </g>
        <g className="bd b-err">
          <path d="M22 22l-5-5M17 22l5-5" />
        </g>
        <g className="bd b-up">
          <path d="M18.5 23v-6.5M15.8 19.2l2.7-2.7 2.7 2.7" />
        </g>
        <g className="bd b-sync">
          <g className="spinr">
            <g transform="translate(6 6)">
              <g transform="translate(12 12) scale(.42) translate(-12 -12)">
                {ARROWS.map((d) => (
                  <path key={d} d={d} vectorEffect="non-scaling-stroke" />
                ))}
              </g>
            </g>
          </g>
        </g>
      </svg>
    </>
  )
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

/** «сегодня, 14:05» or «12 окт., 14:05» */
function when(t: number): string {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return `${today ? 'сегодня' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${hhmm(t)}`
}

/*
 * PC only (spec §11 «Облачко синхронизации — кнопка»): the cloud is a button; it opens a small solid flyout under it
 * with the state, the last sync time or what went wrong, and «Синхронизировать сейчас». It closes on a second
 * click, a click elsewhere, Esc (focus back on the cloud) or leaving the section.
 */
function DeskCloud({
  cls,
  label,
  state,
  lastSyncAt,
  children,
}: {
  cls: string
  label: string
  state: CloudState
  lastSyncAt: number | null
  children: ReactNode
}) {
  const { scheduler } = useApp()
  const toast = useToast()
  const active = useScreenActive()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const fly = useRef<HTMLDivElement>(null)
  const shown = open && active

  useLayoutEffect(() => {
    if (!shown || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.right - 300, window.innerWidth - 308)) })
  }, [shown])

  useEffect(() => {
    if (!shown) return
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      if (!fly.current?.contains(t) && !btn.current?.contains(t)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
      btn.current?.focus()
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [shown])

  const syncNow = async () => {
    const st = await scheduler.syncNow()
    if (st.state !== 'error') toast('Синхронизировано')
  }

  const title =
    state === 'ok' ? 'Всё синхронизировано' : state === 'err' ? 'Синхронизация не удалась' : state === 'sync' ? 'Синхронизирую…' : label
  const sub =
    state === 'err'
      ? label.replace(/^Синхронизация не удалась: /, 'Не удалось отправить: ')
      : lastSyncAt
        ? `Последняя синхронизация: ${when(lastSyncAt)}`
        : 'Ещё не синхронизировалось на этом устройстве'

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cls}
        aria-label={label}
        title={label}
        data-state={state}
        aria-expanded={shown}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {shown &&
        createPortal(
          <div ref={fly} className={`syncfly${state === 'err' ? ' err' : state === 'sync' ? ' busy' : ''}`} role="dialog" aria-label="Синхронизация" style={pos}>
            <div className="sf-head">
              <span className="sf-dot" aria-hidden="true" />
              {title}
            </div>
            <div className="sf-sub">{sub}</div>
            <button type="button" className="fbtn" disabled={state === 'sync'} onClick={() => void syncNow()}>
              {state === 'sync' ? 'Синхронизирую…' : 'Синхронизировать сейчас'}
            </button>
          </div>,
          document.body,
        )}
    </>
  )
}
