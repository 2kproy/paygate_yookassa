import { createHmac, timingSafeEqual } from 'node:crypto'
import { BlockList, isIPv4, isIPv6 } from 'node:net'
import type { FastifyRequest } from 'fastify'
import { config } from './config.js'

/** Собрать BlockList из списка CIDR/адресов (v4 и v6). */
function buildBlockList(entries: string[]): BlockList {
  const bl = new BlockList()
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry) continue
    const [addr, prefix] = entry.split('/')
    if (!addr) continue
    const family = isIPv6(addr) ? 'ipv6' : 'ipv4'
    try {
      if (prefix !== undefined) bl.addSubnet(addr, Number(prefix), family)
      else bl.addAddress(addr, family)
    } catch {
      // некорректная запись в env — пропускаем, не роняем сервис
    }
  }
  return bl
}

const yookassaBlock = buildBlockList(config.yookassa.webhookIps)
const ingressBlock = config.ingress.allowedIps.length ? buildBlockList(config.ingress.allowedIps) : null

function inBlockList(bl: BlockList, ip: string): boolean {
  if (isIPv4(ip)) return bl.check(ip, 'ipv4')
  if (isIPv6(ip)) {
    // IPv4-mapped IPv6 (::ffff:1.2.3.4) — проверяем и как v4
    const mapped = ip.replace(/^::ffff:/i, '')
    if (isIPv4(mapped) && bl.check(mapped, 'ipv4')) return true
    return bl.check(ip, 'ipv6')
  }
  return false
}

/**
 * Реальный IP клиента за Caddy. ВАЖНО: первый элемент X-Forwarded-For задаёт
 * сам клиент (спуфится) — доверять ему для allowlist нельзя. Порядок:
 *  1) X-Real-IP — его выставляет НАШ Caddy как {remote_host} (см. Caddyfile.snippet),
 *     клиент перезаписать не может;
 *  2) ПОСЛЕДНИЙ элемент X-Forwarded-For — тот, что дописал наш Caddy (реальный пир);
 *  3) сокет.
 * Сервис не публикуется наружу (expose, не ports) — достучаться можно только
 * через Caddy, поэтому его заголовкам можно доверять.
 */
export function clientIp(req: FastifyRequest): string {
  const real = req.headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return real.trim()
  const xff = req.headers['x-forwarded-for']
  const chain = Array.isArray(xff) ? xff.join(',') : xff
  if (typeof chain === 'string' && chain.trim()) {
    const parts = chain.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]!
  }
  return req.ip
}

/** Разрешён ли origin для редиректа возврата (анти-open-redirect). */
export function isReturnOriginAllowed(url: string): boolean {
  if (config.redirect.allowedOrigins.length === 0) return true // dev: allowlist не задан
  try {
    const u = new URL(url)
    return config.redirect.allowedOrigins.includes(`${u.protocol}//${u.host}`)
  } catch {
    return false
  }
}

export function isYookassaIp(ip: string): boolean {
  return inBlockList(yookassaBlock, ip)
}

/** HMAC-SHA256(hex) от `${timestamp}.${rawBody}`. */
function sign(secret: string, timestamp: string, raw: Buffer): string {
  return createHmac('sha256', secret).update(timestamp).update('.').update(raw).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

const MAX_SKEW_SEC = 300

export interface IngressCheck {
  ok: boolean
  reason?: string
}

/**
 * Проверка входящего запроса от суб-мерчант:
 *  1) IP в allowlist (если задан);
 *  2) HMAC-подпись `X-Signature` над `${X-Timestamp}.${rawBody}` секретом INGRESS_SECRET;
 *  3) свежесть метки времени (анти-replay, ±5 мин).
 */
export function verifyIngress(req: FastifyRequest, raw: Buffer): IngressCheck {
  if (ingressBlock) {
    const ip = clientIp(req)
    if (!inBlockList(ingressBlock, ip)) return { ok: false, reason: `ip ${ip} not allowed` }
  }

  const ts = req.headers['x-timestamp']
  const sig = req.headers['x-signature']
  if (typeof ts !== 'string' || typeof sig !== 'string') return { ok: false, reason: 'missing signature headers' }

  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > MAX_SKEW_SEC) {
    return { ok: false, reason: 'timestamp skew' }
  }

  const expected = sign(config.ingress.secret, ts, raw)
  if (!safeEqualHex(expected, sig)) return { ok: false, reason: 'bad signature' }
  return { ok: true }
}

/** Заголовки подписи для форварда вебхука на суб-мерчант. */
export function signForward(raw: Buffer): { 'X-Paygate-Timestamp': string; 'X-Paygate-Signature': string } {
  const ts = String(Math.floor(Date.now() / 1000))
  return { 'X-Paygate-Timestamp': ts, 'X-Paygate-Signature': sign(config.forward.secret, ts, raw) }
}
