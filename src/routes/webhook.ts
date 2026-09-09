import type { FastifyInstance, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db, nowSec } from '../db.js'
import { restoreMeta } from '../meta.js'
import { enqueue, kickRelay } from '../relay.js'
import { clientIp, isYookassaIp } from '../security.js'

function raw(req: FastifyRequest): Buffer {
  return (req as any).rawBody instanceof Buffer ? (req as any).rawBody : Buffer.alloc(0)
}

// Обновление жизни токена-редиректа по факту оплаты (косметика: сокращаем окно
// после успеха). Деньги/выдачу это НЕ решает — исход подтверждает суб-мерчант через GET.
const markSucceeded = db.prepare(
  `UPDATE redirect_token SET status = 'succeeded', succeeded_at = ?, expires_at = ? WHERE payment_id = ?`
)
const markCanceled = db.prepare(
  `UPDATE redirect_token SET status = 'canceled', expires_at = ? WHERE payment_id = ? AND status = 'pending'`
)

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(config.webhookPath, async (req, reply) => {
    // Единственная защита ЮKassa — IP-allowlist (тело не подписано). Чужой IP —
    // отвечаем 200, чтобы спуфер не провоцировал ретраи, но ничего не делаем.
    const ip = clientIp(req)
    if (!isYookassaIp(ip)) {
      req.log.error(`yookassa webhook from untrusted ip: ${ip}`)
      return reply.code(200).send({ ok: false })
    }

    const body = raw(req)
    let paymentId: string | null = null
    let event: string | null = null
    let status: string | null = null
    let forwardBody = body.toString()
    try {
      const parsed = JSON.parse(forwardBody || '{}')
      event = typeof parsed.event === 'string' ? parsed.event : null
      const obj = parsed.object ?? {}
      paymentId = typeof obj.id === 'string' ? obj.id : null
      status = typeof obj.status === 'string' ? obj.status : null
      // Восстанавливаем исходные metadata суб-мерчанта перед форвардом (в теле
      // ЮKassa лежит только наш ref) — суб-мерчант получает вебхук как привыкла.
      restoreMeta(parsed.object)
      forwardBody = JSON.stringify(parsed)
    } catch {
      req.log.warn('yookassa webhook: non-JSON body')
    }

    // Форвардим ВСЕ события ЮKassa на суб-мерчант — надёжно (очередь + ретраи).
    enqueue(paymentId, event, forwardBody)

    // Косметика редиректа: подрезаем окно токена после успеха/отмены.
    if (paymentId && event && event.startsWith('payment.')) {
      if (status === 'succeeded') {
        markSucceeded.run(nowSec(), nowSec() + config.redirect.successTtlSeconds, paymentId)
      } else if (status === 'canceled') {
        markCanceled.run(nowSec(), paymentId)
      }
    }

    kickRelay()
    return reply.code(200).send({ ok: true })
  })
}
