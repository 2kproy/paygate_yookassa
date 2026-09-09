import dns from 'node:dns'
// В docker-бридже часто нет IPv6-маршрута — предпочитаем IPv4 для исходящих
// (api.yookassa.ru, форвард на суб-мерчант), иначе fetch может падать.
dns.setDefaultResultOrder('ipv4first')

import Fastify from 'fastify'
import { config } from './config.js'
import { db } from './db.js'
import { startRelay } from './relay.js'
import { paymentsRoutes } from './routes/payments.js'
import { webhookRoutes } from './routes/webhook.js'
import { redirectRoutes } from './routes/redirect.js'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true })

// Сохраняем сырое тело (нужно для HMAC-проверки и для дословного форварда вебхука).
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
  ;(_req as any).rawBody = body
  const buf = body as Buffer
  if (!buf || buf.length === 0) return done(null, {})
  try {
    done(null, JSON.parse(buf.toString()))
  } catch (e) {
    done(e as Error, undefined)
  }
})

app.get('/healthz', async () => ({ ok: true }))

await app.register(paymentsRoutes)
await app.register(webhookRoutes)
await app.register(redirectRoutes)

// Уборка: просроченные токены (сутки) и доставленные/мёртвые вебхуки (7 дней).
setInterval(
  () => {
    try {
      const t = Math.floor(Date.now() / 1000)
      db.prepare(`DELETE FROM redirect_token WHERE expires_at < ?`).run(t - 86400)
      db.prepare(`DELETE FROM webhook_delivery WHERE (delivered_at IS NOT NULL OR dead = 1) AND created_at < ?`).run(
        t - 7 * 86400
      )
      // metadata держим дольше — вебхуки/перепросы статуса могут приходить не сразу.
      db.prepare(`DELETE FROM payment_meta WHERE created_at < ?`).run(t - 30 * 86400)
    } catch (e) {
      app.log.warn(`cleanup failed: ${(e as Error).message}`)
    }
  },
  6 * 3600 * 1000
)

startRelay()

await app.listen({ port: config.port, host: config.host })
app.log.info(`paygate on http://${config.host}:${config.port} — webhook ${config.webhookPath}, return ${config.redirect.returnPath}`)
