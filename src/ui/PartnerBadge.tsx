import './ui.css'

/*
 * The second person's mark (spec §6 «Метка второго человека — нейтральная»): a small circle with her first letter
 * in --partner, ringed with the card colour so it sits cleanly on the corner of a category tile. No pink — it would
 * be confused with «Развлечения».
 */
export function PartnerBadge({ name }: { name: string }) {
  const letter = name.trim().slice(0, 1).toLocaleUpperCase('ru') || '?'
  return (
    <span className="who" title={name} role="img" aria-label={name}>
      {letter}
    </span>
  )
}
