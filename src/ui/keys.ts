/** Enter in a one-line field runs `fn` (the field's «save»). */
export const onEnter = (fn: () => void) => (e: { key: string; preventDefault(): void }) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    fn()
  }
}
