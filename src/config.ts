import 'dotenv/config'

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`)
  return v
}

function list(name: string, fallback = ''): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const DEFAULT_YOOKASSA_IPS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
  '2a02:5180::/32'
]

export const config = {
  port: Number(process.env.PORT ?? 8790),
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl: req('PUBLIC_URL', 'http://localhost:8790').replace(/\/+$/, ''),
  dbPath: process.env.DB_PATH ?? './data/paygate.db',

  yookassa: {
    apiBase: (process.env.YOOKASSA_API_BASE ?? 'https://api.yookassa.ru').replace(/\/+$/, ''),
    shopId: req('YOOKASSA_SHOP_ID'),
    secretKey: req('YOOKASSA_SECRET_KEY'),
    webhookIps: list('YOOKASSA_WEBHOOK_IPS', DEFAULT_YOOKASSA_IPS.join(','))
  },

  webhookPath: process.env.WEBHOOK_PATH ?? '/bff/v1/billing/webhook/yookassa',

  ingress: {
    secret: req('INGRESS_SECRET'),
    // Пусто → IP-проверка входа выключена (dev). В проде задавать обязательно.
    allowedIps: list('INGRESS_ALLOWED_IPS')
  },

  forward: {
    url: req('FORWARD_URL'),
    secret: req('FORWARD_SECRET'),
    maxAttempts: Number(process.env.RELAY_MAX_ATTEMPTS ?? 12)
  },

  redirect: {
    returnPath: process.env.RETURN_PATH ?? '/pay/return',
    allowedOrigins: list('ALLOWED_RETURN_ORIGINS'),
    ttlSeconds: Number(process.env.REDIRECT_TTL_SECONDS ?? 3600),
    successTtlSeconds: Number(process.env.SUCCESS_TTL_SECONDS ?? 180)
  }
}

export type Config = typeof config
