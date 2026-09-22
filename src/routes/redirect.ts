import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db, nowSec, type RedirectToken } from '../db.js'
import { isPayUrlAllowed, isReturnOriginAllowed } from '../security.js'

const findToken = db.prepare(`SELECT * FROM redirect_token WHERE token = ?`)

/** Экранирование для безопасной вставки URL в HTML/JS-строку страницы перехода. */
function esc(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`)
}

// Промежуточная страница перехода на оплату. Не 302 (иначе Referer унаследует
// исходную страницу суб-мерчанта) — настоящий документ агрегатора, который сам
// отправляет браузер на кассу. Referer кассе задаётся meta-политикой (origin →
// `https://<агрегатор>/`, без пути и токена).
function goHtml(payUrl: string): string {
  const u = esc(payUrl)
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${config.pay.goReferrerPolicy}">
<meta name="robots" content="noindex, nofollow">
<title>Переход к оплате…</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ec}
.card{max-width:420px;padding:32px;text-align:center}a{color:#5b9dff}
h1{font-size:20px;margin:0 0 12px}p{opacity:.8;margin:0 0 20px}</style>
<script>window.location.replace(${JSON.stringify(payUrl)});</script></head>
<body><div class="card"><h1>Переходим к оплате…</h1>
<p>Если страница не открылась автоматически, нажмите кнопку ниже.</p>
<a href="${u}" rel="noopener">Перейти к оплате →</a></div></body></html>`
}

/**
 * Страница возврата после оплаты с кнопками (режим 'buttons'). В отличие от 302,
 * касса, зайдя на зарегистрированный return_url, получает страницу агрегатора, а
 * не редирект на домен суб-мерчанта. Кнопка, совпадающая с источником оплаты
 * (сайт/Telegram — по хосту return_url), ведёт на реальный адрес возврата;
 * остальные — на общие ссылки из env. Первой всегда — личный кабинет агрегатора.
 */
function returnButtonsHtml(realReturn: string): string {
  const r = config.redirect
  const host = (() => {
    try {
      return new URL(realReturn).hostname.toLowerCase()
    } catch {
      return ''
    }
  })()
  const isTelegram = host === 't.me' || host.endsWith('.t.me')

  const btns: Array<{ href: string; label: string; primary?: boolean }> = []
  if (r.cabinetUrl) btns.push({ href: r.cabinetUrl, label: r.cabinetLabel, primary: true })
  // Сайт: реальный адрес возврата, если платёж пришёл с сайта; иначе общий.
  const siteHref = isTelegram ? r.siteUrl : realReturn
  if (siteHref) btns.push({ href: siteHref, label: r.siteLabel })
  // Telegram: реальный адрес, если платёж пришёл из Telegram; иначе общий.
  const tgHref = isTelegram ? realReturn : r.telegramUrl
  if (tgHref) btns.push({ href: tgHref, label: r.telegramLabel })

  const buttons = btns
    .map(
      (b) =>
        `<a class="btn${b.primary ? ' primary' : ''}" href="${esc(b.href)}" rel="noopener">${esc(b.label)}</a>`
    )
    .join('\n')

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Оплата завершена</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ec}
.card{max-width:420px;padding:32px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{opacity:.8;margin:0 0 24px}
.btn{display:block;margin:10px 0;padding:13px 18px;border-radius:10px;text-decoration:none;
background:#1c2029;color:#e6e8ec;border:1px solid #2c313c}
.btn.primary{background:#2f6bff;border-color:#2f6bff;color:#fff}</style></head>
<body><div class="card"><h1>Оплата завершена</h1>
<p>Спасибо! Куда перейти дальше?</p>
${buttons}</div></body></html>`
}

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
    // Возвращаем ТОЛЬКО по живому токену реального платежа агрегатора; иначе — заглушка.
    if (!row || row.expires_at < nowSec() || !isReturnOriginAllowed(row.return_url)) {
      return reply.code(404).type('text/html; charset=utf-8').send(STUB_HTML)
    }

    const target = new URL(row.return_url)
    target.searchParams.set('paid', '1')

    // Режим 'buttons': не редиректим на домен суб-мерчанта (иначе касса, зайдя
    // на return_url, получит 302 на этот домен). Отдаём страницу агрегатора.
    if (config.redirect.mode === 'buttons') {
      return reply
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(returnButtonsHtml(target.toString()))
    }

    return reply.header('location', target.toString()).code(302).send()
  })

  // Переход НА оплату: отдаём HTML-страницу агрегатора, которая сама отправляет
  // браузер на кассу. Referer кассе = домен агрегатора (meta-политика).
  app.get(config.pay.goPath, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const id = (req.query as { id?: string }).id
    if (!id) return reply.code(404).type('text/html; charset=utf-8').send(STUB_HTML)

    const row = findToken.get(id) as RedirectToken | undefined
    // Ведём на оплату ТОЛЬКО по живому токену реального платежа и только если
    // сохранённая ссылка ведёт на кассу (анти-open-redirect). Иначе — заглушка.
    if (
      !row ||
      !row.pay_url ||
      row.expires_at < nowSec() ||
      row.status !== 'pending' ||
      !isPayUrlAllowed(row.pay_url)
    ) {
      return reply.code(404).type('text/html; charset=utf-8').send(STUB_HTML)
    }

    return reply.type('text/html; charset=utf-8').send(goHtml(row.pay_url))
  })
}
