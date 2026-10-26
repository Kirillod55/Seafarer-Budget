import { useSyncExternalStore } from 'react'

/*
 * Windows app auto-update (spec §11 «Автообновление программы для Windows»): Tauri's updater reads latest.json of
 * the latest GitHub release (endpoint and public key in src-tauri/tauri.conf.json) at start and every 6 hours.
 * A newer version shows a notification bottom right («Доступна версия 1.2.0 · Что нового · Обновить и
 * перезапустить · Позже»); «Позже» hides it until the next start. The download shows its progress, then the app
 * restarts — records are safe in Dexie and the server. No network (at sea): the check is silently skipped. A failed
 * download says «Не удалось обновить, попробую позже». The plugins are loaded only inside Tauri (dynamic import).
 */

export interface UpdateInfo {
  version: string
  notes: string
  /** Downloads and installs, reporting 0…1 (null while the size is unknown), then restarts the app. */
  install(onProgress: (share: number | null) => void): Promise<void>
}

export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'failed'

export interface UpdateState {
  phase: UpdatePhase
  info: UpdateInfo | null
  progress: number | null
}

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
export const FAILED_TEXT = 'Не удалось обновить, попробую позже'

export interface Updater {
  get(): UpdateState
  subscribe(f: () => void): () => void
  /** One check; resolves to the newer version or null (none, offline, or the check failed). */
  checkNow(): Promise<UpdateInfo | null>
  /** «Позже»: hidden until the app starts again. */
  later(): void
  install(): Promise<void>
  /** First check now, then every 6 h; returns the stop function. */
  start(): () => void
}

export function createUpdater({
  check,
  online = () => navigator.onLine,
  everyMs = CHECK_EVERY_MS,
}: {
  check(): Promise<UpdateInfo | null>
  online?(): boolean
  everyMs?: number
}): Updater {
  let state: UpdateState = { phase: 'idle', info: null, progress: null }
  let dismissed = false
  const subs = new Set<() => void>()
  const set = (s: Partial<UpdateState>) => {
    state = { ...state, ...s }
    subs.forEach((f) => f())
  }

  const checkNow = async () => {
    if (!online()) return null
    try {
      const info = await check()
      if (info && !dismissed && state.phase !== 'downloading') set({ phase: 'available', info, progress: null })
      return info
    } catch {
      return null // the server or GitHub did not answer: try again next time
    }
  }

  return {
    get: () => state,
    subscribe(f) {
      subs.add(f)
      return () => subs.delete(f)
    },
    checkNow,
    later() {
      // «Позже» on an offer hides it until the next start; closing a failed download lets the next check offer it again
      if (state.phase !== 'failed') dismissed = true
      set({ phase: 'idle' })
    },
    async install() {
      const info = state.info
      if (!info || state.phase === 'downloading') return
      set({ phase: 'downloading', progress: 0 })
      try {
        await info.install((progress) => set({ progress }))
      } catch {
        set({ phase: 'failed', progress: null })
      }
    },
    start() {
      void checkNow()
      const timer = setInterval(() => void checkNow(), everyMs)
      return () => clearInterval(timer)
    },
  }
}

/** The real check inside the Windows app (Tauri plugins updater + process). */
export async function tauriCheck(): Promise<UpdateInfo | null> {
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  if (!update) return null
  return {
    version: update.version,
    notes: update.body ?? '',
    async install(onProgress) {
      let total = 0
      let got = 0
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') {
          total = e.data.contentLength ?? 0
          onProgress(total ? 0 : null)
        } else if (e.event === 'Progress') {
          got += e.data.chunkLength
          onProgress(total ? Math.min(1, got / total) : null)
        }
      })
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    },
  }
}

let shared: Updater | null = null

/** The app's updater: set once at start inside Tauri (main.tsx); null in the browser and on the phone. */
export function setAppUpdater(u: Updater | null): void {
  shared = u
}

export function appUpdater(): Updater | null {
  return shared
}

const IDLE: UpdateState = { phase: 'idle', info: null, progress: null }
const noop = () => () => {}

export function useUpdateState(u: Updater | null): UpdateState {
  return useSyncExternalStore(u ? u.subscribe : noop, u ? u.get : () => IDLE)
}
