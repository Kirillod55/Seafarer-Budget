import type { Account, Category, Transaction, TxKind } from '@shared/types.ts'

const BOM = '﻿' // makes Excel read the file as UTF-8
const SEPARATOR = ';'
const EOL = '\r\n'
const REVOKE_DELAY_MS = 100
const HEADER = ['Дата', 'Тип', 'Сумма', 'Валюта', 'Сумма USD', 'Категория', 'Счёт', 'Заметка']

const KIND_LABEL: Record<TxKind, string> = {
  expense: 'Расход',
  income: 'Доход',
  transfer: 'Перевод',
  exchange: 'Обмен',
  adjustment: 'Корректировка',
}

/** A cell: quoted CSV-style when it holds the separator, a quote or a line break. */
function cell(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** 12.5 → «12,5» */
const number = (n: number) => String(n).replace('.', ',')

/** UTF-8 CSV text (BOM, «;» separator, decimal comma) of the live transactions, in the given order. */
export function toCsv(txs: Transaction[], categories: Category[], accounts: Account[]): string {
  const categoryName = new Map(categories.map((c) => [c.id, c.name]))
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))

  const rows = txs
    .filter((t) => !t.deleted)
    .map((t) => {
      // the second leg of a transfer / exchange has no column of its own, so it goes in front of the note
      let leg = ''
      if (t.kind === 'transfer' && t.to_account_id) {
        leg = `→ ${accountName.get(t.to_account_id) ?? ''}`
      } else if (t.kind === 'exchange' && t.to_amount !== null && t.to_currency !== null) {
        leg = `→ ${number(t.to_amount)} ${t.to_currency}`
      }
      const note = leg && t.note ? `${leg} ${t.note}` : leg || t.note
      return [
        t.date,
        KIND_LABEL[t.kind] ?? t.kind,
        number(t.amount),
        t.currency,
        number(t.amount_usd),
        (t.category_id && categoryName.get(t.category_id)) || '',
        accountName.get(t.account_id) ?? '',
        note,
      ]
        .map(cell)
        .join(SEPARATOR)
    })

  return BOM + [HEADER.join(SEPARATOR), ...rows].join(EOL) + EOL
}

export const csvFileName = (date: string) => `seafarer-budget-${date}.csv`

/** Saves text as a file through a temporary `<a download>` (works in Tauri's webview and Safari). */
export function downloadCsv(fileName: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.hidden = true
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // not at once: Safari starts reading the blob after the click handler returns
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
  }
}
