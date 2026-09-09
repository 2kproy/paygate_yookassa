import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db, nowSec } from '../db.js'
import { maskMetadata, restoreMeta, storeMeta } from '../meta.js'
import { isReturnOriginAllowed, verifyIngress } from '../security.js'
import { yookassa } from '../yookassa.js'

function raw(req: FastifyRequest): Buffer {
  return (req as any).rawBody instanceof Buffer ? (req as any).rawBody : Buffer.alloc(0)
}

function idemKey(req: FastifyRequest): string | undefined {
  return String(req.headers['idempotence-key'] ?? '') || undefined
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const insertToken = db.prepare(
  `INSERT INTO redirect_token (token, payment_id, order_id, return_url, status, created_at, expires_at)
   VALUES (@token, @payment_id, @order_id, @return_url, 'pending', @created_at, @expires_at)`
)

/**
 * Прозрачный прокси ЮKassa под /agg/v1 (зеркалит /v3): суб-мерчант шлёт СЫРОЕ тело
 * ЮKassa как раньше, мы лишь подставляем авторизацию кассы агрегатора и для
 * интерактивной оплаты переписываем confirmation.return_url на токен-редирект.
 */
export async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  // HMAC + IP проверка входа над сырым телом — для всех /agg/*.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/agg/')) return
    const check = verifyIngress(req, raw(req))
    if (!check.ok) {
      req.log.warn(`ingress rejected: ${check.reason}`)
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })

  // POST /agg/v1/payments — создание платежа ИЛИ автосписание (payment_method_id).
  app.post('/agg/v1/payments', async (req, reply) => {
    const payload = req.body as Record<string, any>
    if (!isObject(payload)) return reply.code(400).send({ error: 'bad request' })

    const isRecurring = typeof payload.payment_method_id === 'string'
    let token: string | null = null
    let origReturn: string | null = null

    // Интерактивная оплата: перехватываем return_url суб-мерчанта → наш редирект.
    // Автосписание (payment_method_id) идёт как есть, без токена/редиректа.
    if (!isRecurring && isObject(payload.confirmation) && typeof payload.confirmation.return_url === 'string') {
      origReturn = payload.confirmation.return_url
      if (!isReturnOriginAllowed(origReturn)) {
        return reply.code(400).send({ error: 'return_url origin not allowed' })
      }
      token = randomBytes(24).toString('hex')
      // Сохраняем прочие поля confirmation (напр. locale), меняем только return_url.
      payload.confirmation = {
        ...payload.confirmation,
        type: 'redirect',
        return_url: `${config.publicUrl}${config.redirect.returnPath}?id=${token}`
      }
    }

    // Прячем metadata от ЮKassa (в неё уходит только ref), оригинал храним у себя.
    const orderId = String((payload as any)?.metadata?.orderId ?? (payload as any)?.metadata?.bot_order_id ?? '') || null
    const { original, ref } = maskMetadata(payload)

    const result = await yookassa.createPayment(payload, idemKey(req))

    if (result.status >= 200 && result.status < 300 && result.data?.id) {
      storeMeta(String(result.data.id), ref, original)
      restoreMeta(result.data) // вернуть суб-мерчанту его metadata как обычно
      if (token && origReturn) {
        insertToken.run({
          token,
          payment_id: String(result.data.id),
          order_id: orderId,
          return_url: origReturn,
          created_at: nowSec(),
          expires_at: nowSec() + config.redirect.ttlSeconds
        })
      }
    }

    return reply.code(result.status).send(result.data)
  })

  // GET /agg/v1/payments/:id — перезапрос статуса (суб-мерчант перепроверяет исход).
  app.get('/agg/v1/payments/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const result = await yookassa.getPayment(id)
    restoreMeta(result.data) // вернуть исходные metadata (перепрос статуса суб-мерчант)
    return reply.code(result.status).send(result.data)
  })

  // POST /agg/v1/refunds — возврат средств (сырое тело как есть).
  app.post('/agg/v1/refunds', async (req, reply) => {
    const payload = req.body as Record<string, any>
    if (!isObject(payload)) return reply.code(400).send({ error: 'bad request' })
    const result = await yookassa.createRefund(payload, idemKey(req))
    return reply.code(result.status).send(result.data)
  })
}
