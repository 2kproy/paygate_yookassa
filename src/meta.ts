import { randomBytes } from 'node:crypto'
import { db, nowSec } from './db.js'

/**
 * Виртуализация metadata: наружу (в ЮKassa) уходит только непрозрачный ref,
 * оригинал суб-мерчанта хранится тут и восстанавливается на обратном пути.
 * Так касса/эквайер не видит telegram_id, название тарифа и пр. привязку к
 * сервису — а суб-мерчант получает свои metadata как обычно (правки не нужны).
 */

const put = db.prepare(
  `INSERT INTO payment_meta (payment_id, ref, meta_json, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(payment_id) DO UPDATE SET meta_json = excluded.meta_json, ref = excluded.ref`
)
const get = db.prepare(`SELECT meta_json FROM payment_meta WHERE payment_id = ?`)

/** Заменить payload.metadata на непрозрачный ref ПЕРЕД отправкой в ЮKassa. */
export function maskMetadata(payload: Record<string, any>): { original: unknown; ref: string | null } {
  const original = payload.metadata
  if (original === undefined || original === null) return { original: null, ref: null }
  const ref = randomBytes(8).toString('hex')
  payload.metadata = { ref } // непрозрачная метка для кросс-сверки в кабинете
  return { original, ref }
}

/** Сохранить оригинал metadata по id платежа (после ответа ЮKassa). */
export function storeMeta(paymentId: string, ref: string | null, original: unknown): void {
  if (original === null || original === undefined) return
  put.run(paymentId, ref, JSON.stringify(original), nowSec())
}

/** Восстановить исходные metadata в объекте платежа (вебхук / перепрос / ответ). */
export function restoreMeta(paymentObject: any): void {
  if (!paymentObject || typeof paymentObject !== 'object' || typeof paymentObject.id !== 'string') return
  const row = get.get(paymentObject.id) as { meta_json: string } | undefined
  if (!row) return
  try {
    paymentObject.metadata = JSON.parse(row.meta_json)
  } catch {
    // оставляем как есть
  }
}
