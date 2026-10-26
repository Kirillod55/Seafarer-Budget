import { useState } from 'react'
import { appUpdater } from '../../desk/updater.ts'
import { useToast } from '../../ui/Toast.tsx'
import { Info } from '../../ui/icons.ts'
import { SRow } from './common.tsx'

/** PC «Настройки → О программе» (spec §11 «Автообновление»): the version and, in the Windows app, «Проверить обновления». */
export function AboutSection() {
  const toast = useToast()
  const updater = appUpdater()
  const [busy, setBusy] = useState(false)
  const check = async () => {
    if (!updater || busy) return
    if (!navigator.onLine) return toast('Нет сети — проверю, когда появится связь')
    setBusy(true)
    try {
      // a newer version shows its own notification bottom right
      if (!(await updater.checkNow())) toast('Установлена последняя версия')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SRow
      icon={Info}
      color="#0A84FF"
      title={`Seafarer Budget ${__APP_VERSION__}`}
      desc={updater ? 'Обновляется сама из выпусков GitHub' : 'Версия в браузере обновляется при открытии'}
    >
      {updater && (
        <button type="button" className="fbtn" disabled={busy} onClick={() => void check()}>
          {busy ? 'Проверяю…' : 'Проверить обновления'}
        </button>
      )}
    </SRow>
  )
}
