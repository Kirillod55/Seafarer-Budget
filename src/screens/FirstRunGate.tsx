import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../context.tsx'
import { resolveStartup, type StartupState } from '../startup.ts'
import { Wizard } from './Wizard.tsx'

type GateState = StartupState | 'loading'

/** After login: decides between the app, the first-run wizard and «Нужен интернет» (R18). */
export function FirstRunGate({
  syncOnce,
  children,
}: {
  syncOnce: () => Promise<unknown>
  children: ReactNode
}) {
  const { db } = useApp()
  const [state, setState] = useState<GateState>('loading')

  const check = useCallback(async () => {
    setState('loading')
    setState(await resolveStartup(db, syncOnce))
  }, [db, syncOnce])

  useEffect(() => {
    void check()
  }, [check])

  if (state === 'loading') return <p className="splash muted">Загрузка…</p>
  if (state === 'need_internet') {
    return (
      <main className="page narrow center">
        <h1>Нужен интернет для первого запуска</h1>
        <p className="muted">Приложению нужно один раз загрузить ваши данные. Подключитесь к сети и повторите.</p>
        <button type="button" className="btn-acc" onClick={() => void check()}>
          Повторить
        </button>
      </main>
    )
  }
  if (state === 'wizard') return <Wizard onDone={() => setState('ready')} />
  return <>{children}</>
}
