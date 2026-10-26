import { useId, type CSSProperties, type ReactNode } from 'react'
import type { Settings } from '@shared/types.ts'
import { useApp } from '../../context.tsx'
import type { LucideIcon } from '../../ui/icons.ts'
import { useToast } from '../../ui/Toast.tsx'

export const FAILED = 'Не получилось — попробуй ещё раз'

/** A card of «Ещё» (prototype more(): .card.stack with an h3): a region named by its title. */
export function MoreCard({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className={`mcard rec${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  )
}

/**
 * Saves settings field by field (spec §7, R: `repo.put('settings', { id, ...changed })`): the repo marks just these
 * fields in `_changed`, so the sync pushes only them. A failure shows the usual toast; resolves to success.
 */
export function useSaveSettings(settings: Pick<Settings, 'id'>) {
  const { repo } = useApp()
  const toast = useToast()
  return async (patch: Partial<Omit<Settings, 'id'>>): Promise<boolean> => {
    try {
      await repo.put<Settings>('settings', { id: settings.id, ...patch })
      return true
    } catch {
      toast(FAILED)
      return false
    }
  }
}


/** PC «Параметры» (spec §11; prototype moreDesk): a group title and its rows. */
export function SGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="sgroup" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  )
}

/**
 * One row of a Windows Settings group: the icon on a tile of its colour, the name and the line under it on the left,
 * the control on the right. `htmlFor` makes the name the label of that control.
 */
export function SRow({
  icon: Icon,
  color,
  title,
  desc,
  htmlFor,
  children,
  className,
}: {
  icon: LucideIcon
  color: string
  title: ReactNode
  desc?: ReactNode
  htmlFor?: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={`srow${className ? ` ${className}` : ''}`}>
      <span className="ic" style={{ '--c': color } as CSSProperties} aria-hidden="true">
        <Icon strokeWidth={2} />
      </span>
      <div className="stext">
        {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <b>{title}</b>}
        {desc && <span className="label">{desc}</span>}
      </div>
      {children && <div className="sctl">{children}</div>}
    </div>
  )
}
