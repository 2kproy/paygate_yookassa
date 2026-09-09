import { config } from './config.js'
import { db, nowSec, type WebhookDelivery } from './db.js'
import { signForward } from './security.js'

/** Бэкофф доставки по номеру попытки (сек). Последнее значение тянется до maxAttempts. */
const BACKOFF = [10, 30, 60, 120, 300, 600, 1200, 1800, 3600]

function backoff(attempt: number): number {
  return BACKOFF[Math.min(attempt, BACKOFF.length - 1)]!
}

const insertStmt = db.prepare(
  `INSERT INTO webhook_delivery (payment_id, event, body, next_attempt_at, created_at)
   VALUES (?, ?, ?, ?, ?)`
)

/** Поставить сырое тело вебхука ЮKassa в очередь доставки на суб-мерчант. */
export function enqueue(paymentId: string | null, event: string | null, rawBody: string): void {
  const ts = nowSec()
  insertStmt.run(paymentId, event, rawBody, ts, ts)
}

const dueStmt = db.prepare(
  `SELECT * FROM webhook_delivery
    WHERE dead = 0 AND delivered_at IS NULL AND next_attempt_at <= ?
    ORDER BY next_attempt_at ASC LIMIT 20`
)
const markDelivered = db.prepare(`UPDATE webhook_delivery SET delivered_at = ?, attempts = attempts + 1 WHERE id = ?`)
const markRetry = db.prepare(
  `UPDATE webhook_delivery SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?`
)
const markDead = db.prepare(
  `UPDATE webhook_delivery SET dead = 1, attempts = attempts + 1, last_error = ? WHERE id = ?`
)

async function deliver(row: WebhookDelivery): Promise<void> {
  const raw = Buffer.from(row.body)
  try {
    const res = await fetch(config.forward.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signForward(raw)
      },
      body: raw,
      signal: AbortSignal.timeout(20_000)
    })
    if (res.status >= 200 && res.status < 300) {
      markDelivered.run(nowSec(), row.id)
      return
    }
    throw new Error(`forward HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  } catch (e) {
    const err = (e as Error).message.slice(0, 500)
    const nextAttempt = row.attempts + 1
    if (nextAttempt >= config.forward.maxAttempts) {
      markDead.run(err, row.id)
      console.error(`[relay] DEAD delivery id=${row.id} payment=${row.payment_id} after ${nextAttempt} attempts: ${err}`)
    } else {
      markRetry.run(nowSec() + backoff(row.attempts), err, row.id)
      console.warn(`[relay] retry id=${row.id} payment=${row.payment_id} attempt=${nextAttempt}: ${err}`)
    }
  }
}

let running = false
async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const rows = dueStmt.all(nowSec()) as WebhookDelivery[]
    for (const row of rows) await deliver(row)
  } finally {
    running = false
  }
}

/** Запустить фоновую доставку очереди. */
export function startRelay(): void {
  setInterval(() => void tick(), 3000)
}

/** Пнуть доставку немедленно (после приёма вебхука), не дожидаясь тика. */
export function kickRelay(): void {
  void tick()
}
