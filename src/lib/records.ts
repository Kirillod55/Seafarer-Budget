import type { Category, Transaction } from '@shared/types.ts'
import type { Who } from '../nav/Navigator.tsx'

/* Shared by the records, report, calendar, archive and settings screens: who wrote a record, and its category tile. */

/** The tile for a record without a category (transfer, exchange, adjustment): neutral grey wallet. */
export function bareCategory(name: string): Category {
  return {
    id: '',
    deleted: false,
    name,
    kind: 'expense',
    icon: '',
    keywords: [],
    archived: false,
    sort: 0,
    color: '#8E8E93',
    glyph: 'wallet',
    deleted_at: null,
    deleted_batch: null,
  }
}

/** The second person's name in the interface: settings.partner_name, «Она» when unset. */
export const partnerLabel = (name: string | null | undefined): string => (name ?? '').trim() || 'Она'

/** «Все / Я / Маша» */
export const whoOptions = (partner: string): { value: Who; label: string }[] => [
  { value: 'all', label: 'Все' },
  { value: 'me', label: 'Я' },
  { value: 'partner', label: partner },
]

/** The records of whoever is chosen: everyone, the owner's, or the second person's. */
export function byWho(txs: Transaction[], who: Who): Transaction[] {
  if (who === 'all') return txs
  const author = who === 'me' ? 'owner' : 'partner'
  return txs.filter((t) => t.author === author)
}

/** The category of a report row / route key, or a grey «Без категории» tile. */
export function categoryOf(key: string, byId: Map<string, Category>): Category {
  return byId.get(key) ?? bareCategory('Без категории')
}
