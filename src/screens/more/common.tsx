import { useId, type ReactNode } from 'react'
import type { Settings } from '@shared/types.ts'
import { useApp } from '../../context.tsx'
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

