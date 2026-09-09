import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db, nowSec, type RedirectToken } from '../db.js'
import { isReturnOriginAllowed } from '../security.js'

const findToken = db.prepare(`SELECT * FROM redirect_token WHERE token = ?`)

const STUB_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Личный кабинет</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ec}
.card{max-width:420px;padding:32px;text-align:center}a{color:#5b9dff;text-decoration:none}
h1{font-size:20px;margin:0 0 12px}p{opacity:.8;margin:0 0 20px}</style></head>
<body><div class="card"><h1>Ссылка недействительна</h1>
<p>Платёж не найден или ссылка устарела. Войдите в личный кабинет, чтобы проверить статус.</p>
<a href="${config.publicUrl}">Перейти на сайт →</a></div></body></html>`

export async function redirectRoutes(app: FastifyInstance): Promise<void> {
  app.get(config.redirect.returnPath, async (req, reply) => {
    const id = (req.query as { id?: string }).id
    if (!id) return reply.code(404).type('text/html; charset=utf-8').send(STUB_HTML)

    const row = findToken.get(id) as RedirectToken | undefined
    // Редиректим ТОЛЬКО по живому токену реального платежа агрегатора; иначе — заглушка.
    if (!row || row.expires_at < nowSec() || !isReturnOriginAllowed(row.return_url)) {
      return reply.code(404).type('text/html; charset=utf-8').send(STUB_HTML)
    }

    const target = new URL(row.return_url)
    target.searchParams.set('paid', '1')
    return reply.header('location', target.toString()).code(302).send()
  })
}
