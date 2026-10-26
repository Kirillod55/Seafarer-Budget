import { useState } from 'react'
import { FAILED_TEXT, useUpdateState, type Updater } from './updater.ts'

/** Bottom right, like a Windows notification (spec §11 «Автообновление»); nothing while there is no update. */
export function UpdateToast({ updater }: { updater: Updater | null }) {
  const st = useUpdateState(updater)
  const [notes, setNotes] = useState(false)
  if (!updater || st.phase === 'idle' || !st.info) return null
  return (
    <div className="upd" role="status" aria-label="Обновление программы">
      {st.phase === 'failed' ? (
        <>
          <b>{FAILED_TEXT}</b>
          <div className="upd-acts">
            <button type="button" className="fbtn" onClick={updater.later}>
              Закрыть
            </button>
          </div>
        </>
      ) : (
        <>
          <b>{`Доступна версия ${st.info.version}`}</b>
          {notes && st.info.notes && <p className="label">{st.info.notes}</p>}
          {st.phase === 'downloading' ? (
            <progress aria-label="Загрузка обновления" max={1} value={st.progress ?? undefined} />
          ) : (
            <div className="upd-acts">
              {st.info.notes && (
                <button type="button" className="fbtn" aria-expanded={notes} onClick={() => setNotes((n) => !n)}>
                  Что нового
                </button>
              )}
              <button type="button" className="fbtn" onClick={updater.later}>
                Позже
              </button>
              <button type="button" className="fbtn primary" onClick={() => void updater.install()}>
                Обновить и перезапустить
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
