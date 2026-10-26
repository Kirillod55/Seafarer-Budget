// Fuzzy word helpers shared by the parser (spec §5 «Умное узнавание счёта», «Опечатки в валюте»). Pure.

const CYR_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'j', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g', "'": '', 'ʼ': '',
}
const UKR = /[іїєґ]/u

/** Cyrillic (Russian and Ukrainian) -> Latin; Ukrainian «и» is «y». */
export function translit(s: string): string {
  const uk = UKR.test(s)
  let out = ''
  for (const ch of s) out += uk && ch === 'и' ? 'y' : (CYR_LAT[ch] ?? ch)
  return out
}

/**
 * The «key» an account name or a word is compared by: lower case -> Latin -> sound pairs
 * (c→k, q→k, w→v, x→ks, ph→f, y→i) -> no spaces/hyphens -> no trailing «bank».
 */
export function accountKey(s: string): string {
  return translit(s.toLowerCase())
    .replace(/ph/g, 'f')
    .replace(/[cq]/g, 'k')
    .replace(/w/g, 'v')
    .replace(/x/g, 'ks')
    .replace(/y/g, 'i')
    .replace(/[\s\-_.]+/g, '')
    .replace(/bank$/, '')
}

/** Optimal string alignment (Damerau–Levenshtein with adjacent transpositions). */
export function damerau(a: string, b: string): number {
  const A = [...a]
  const B = [...b]
  const d: number[][] = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array(B.length).fill(0)])
  for (let j = 1; j <= B.length; j++) d[0][j] = j
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[A.length][B.length]
}

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,."
const RU = 'йцукенгшщзхъфывапролджэячсмитьбю'

/** The same keys typed in the other keyboard layout (en <-> ru); null when the word mixes both. */
export function layoutSwap(s: string): string | null {
  let out = ''
  for (const ch of s) {
    const e = EN.indexOf(ch)
    const r = RU.indexOf(ch)
    if (e >= 0) out += RU[e]
    else if (r >= 0) out += EN[r]
    else return null
  }
  return out
}

const LAT_CYR: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н',
  o: 'о', p: 'п', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', y: 'ы', z: 'з',
}

/** Latin letters read as their Cyrillic look/sound-alikes (`grн` -> `грн`, `grivna` -> `гривна`). */
export function latinToCyr(s: string): string {
  let out = ''
  for (const ch of s) out += LAT_CYR[ch] ?? ch
  return out
}

/** Does a word key point at an account key: prefix either way (>= 4 letters) or <= 1 typo (<= 2 from 8 letters). */
export function keyMatches(word: string, account: string): boolean {
  if (word.length < 4 || account.length < 2) return false
  if (account.startsWith(word)) return true
  if (account.length >= 4 && word.startsWith(account)) return true
  return damerau(word, account) <= (Math.min(word.length, account.length) >= 8 ? 2 : 1)
}
