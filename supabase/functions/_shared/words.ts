// Numbers written as words and money slang -> digits, before the parser looks for amounts (spec §5:
// «молоко сорок», «тысяча двести», «полтора», «сотка», «косарь», «2к», «пол косаря»). Pure, no imports.

const UNITS: Record<string, number> = {
  'ноль': 0, 'два': 2, 'две': 2, 'дві': 2, 'три': 3, 'четыре': 4, 'чотири': 4, 'пять': 5, "п'ять": 5, 'пʼять': 5,
  'шесть': 6, 'шість': 6, 'семь': 7, 'сім': 7, 'восемь': 8, 'вісім': 8, 'девять': 9, "дев'ять": 9, 'девʼять': 9,
  'десять': 10, 'одиннадцать': 11, 'одинадцять': 11, 'двенадцать': 12, 'дванадцять': 12, 'тринадцать': 13,
  'тринадцять': 13, 'четырнадцать': 14, 'чотирнадцять': 14, 'пятнадцать': 15, "п'ятнадцять": 15,
  'шестнадцать': 16, 'шістнадцять': 16, 'семнадцать': 17, 'сімнадцять': 17, 'восемнадцать': 18,
  'вісімнадцять': 18, 'девятнадцать': 19, "дев'ятнадцять": 19,
}
/** «один» counts only inside a compound («двадцать один»): alone it is an article, not an amount. */
const ONE = new Set(['один', 'одна', 'одно', 'одну', 'одного'])
const TENS: Record<string, number> = {
  'двадцать': 20, 'двадцять': 20, 'тридцать': 30, 'тридцять': 30, 'сорок': 40, 'пятьдесят': 50, "п'ятдесят": 50,
  'шестьдесят': 60, 'шістдесят': 60, 'семьдесят': 70, 'сімдесят': 70, 'восемьдесят': 80, 'вісімдесят': 80,
  'девяносто': 90, "дев'яносто": 90,
}
const HUNDREDS: Record<string, number> = {
  'сто': 100, 'двести': 200, 'двісті': 200, 'триста': 300, 'четыреста': 400, 'чотириста': 400, 'пятьсот': 500,
  "п'ятсот": 500, 'шестьсот': 600, 'шістсот': 600, 'семьсот': 700, 'сімсот': 700, 'восемьсот': 800,
  'вісімсот': 800, 'девятьсот': 900, "дев'ятсот": 900,
}
/** Stand-alone slang amounts. */
const SLANG: Record<string, number> = {
  'сотка': 100, 'сотку': 100, 'сотки': 100, 'сотня': 100, 'сотню': 100, 'стольник': 100,
  'полтос': 50, 'полтинник': 50, 'пятихатка': 500, 'пятихатку': 500,
}
/** ×1000: «тысяча», slang «косарь / штука / тыща» in every form. */
const THOUSAND = new Set([
  'тысяча', 'тысячи', 'тысяч', 'тысячу', 'тисяча', 'тисячі', 'тисяч', 'тисячу', 'косарь', 'косаря', 'косарей',
  'косарік', 'штука', 'штуки', 'штук', 'штуку', 'тыща', 'тыщи', 'тыщ', 'тыщу',
])
const HALF_AND = ['с', 'половиной'] // «двадцать пять с половиной»
const ONE_AND_HALF = new Set(['полтора', 'полторы', 'півтора', 'півтори'])
const HALF = new Set(['пол', 'пів'])

const K_RE = /^(\d+(?:[.,]\d+)?)[кk]$/u // 2к, 2k, 2.5к

const PUNCT = /^([.,!?;:()"'«»]*)(.*?)([.,!?;:()"'«»]*)$/u

/** Replace number words and slang in a lower-case, space-separated text with digits. */
export function numberWords(text: string): string {
  const tokens = text.split(' ')
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    const [, lead, word, trail] = PUNCT.exec(tokens[i])!
    const k = K_RE.exec(word)
    if (k) {
      out.push(`${lead}${fmt(Number(k[1].replace(',', '.')) * 1000)}${trail}`)
      i++
      continue
    }
    const run = readNumber(tokens, i)
    if (run) {
      const lastTrail = PUNCT.exec(tokens[run.end - 1])![3]
      out.push(`${lead}${fmt(run.value)}${lastTrail}`)
      i = run.end
      continue
    }
    out.push(tokens[i])
    i++
  }
  return out.join(' ')
}

const fmt = (n: number) => String(Math.round(n * 100) / 100)
const bare = (t: string | undefined) => (t === undefined ? '' : PUNCT.exec(t)![2])

/** A run of number words starting at i: its value and the index after it, or null. */
function readNumber(tokens: string[], i: number): { value: number; end: number } | null {
  let total = 0
  let current = 0
  let words = 0
  let j = i
  let sawOne = false
  // a digit right before a thousand word: «2 косаря», «3 тысячи»
  if (/^\d+(?:[.,]\d+)?$/.test(bare(tokens[j])) && THOUSAND.has(bare(tokens[j + 1]))) {
    return { value: Number(bare(tokens[j]).replace(',', '.')) * 1000, end: j + 2 }
  }
  while (j < tokens.length) {
    const w = bare(tokens[j])
    // punctuation inside the run (except at its end) breaks it: «сорок, двадцать» are two numbers
    if (words > 0 && PUNCT.exec(tokens[j - 1])![3]) break
    if (HALF.has(w) && THOUSAND.has(bare(tokens[j + 1]))) {
      current += 0.5
      words++
      j++
      continue
    }
    if (ONE_AND_HALF.has(w)) {
      current += 1.5
    } else if (w in SLANG && words === 0) {
      return { value: SLANG[w], end: j + 1 }
    } else if (w in HUNDREDS) {
      current += HUNDREDS[w]
    } else if (w in TENS) {
      current += TENS[w]
    } else if (w in UNITS) {
      current += UNITS[w]
    } else if (ONE.has(w)) {
      current += 1
      sawOne = true
    } else if (THOUSAND.has(w)) {
      // «тысяча» alone is 1000; slang alone («косарь») too
      total += (current || 1) * 1000
      current = 0
    } else if (w === HALF_AND[0] && bare(tokens[j + 1]) === HALF_AND[1] && words > 0) {
      current += 0.5
      words++
      j += 2
      break
    } else {
      break
    }
    words++
    j++
  }
  if (words === 0) return null
  if (words === 1 && sawOne) return null // a lone «один / одна»
  return { value: total + current, end: j }
}
