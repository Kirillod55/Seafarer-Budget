import type { ReactNode } from 'react'
import { Anchor } from '../ui/icons.ts'

/*
 * The left pane of the PC sign-in and setup (spec §11 «Вход и мастер первого запуска на ПК»; prototype auBrand): the
 * anchor, «Seafarer Budget», the tag line, what goes in the middle (features or the setup steps), the version at the
 * bottom, a soft lime glow in the corner. The right pane is the form.
 */
export function AuthBrand({ children }: { children: ReactNode }) {
  return (
    <aside className="au-brand">
      <div>
        <span className="au-logo" aria-hidden="true">
          <Anchor strokeWidth={2.2} />
        </span>
        <p className="au-name">Seafarer Budget</p>
        <p className="au-tag">Личный бюджет моряка — от рейса до посадки</p>
      </div>
      {children}
      <p className="au-ver">{`Версия ${__APP_VERSION__.split('.').slice(0, 2).join('.')} · для Windows`}</p>
    </aside>
  )
}
