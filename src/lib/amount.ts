/** «12,5» and «12.5» both work; anything that is not a number gives NaN. */
export function parseAmount(text: string): number {
  const n = Number(text.trim().replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}
