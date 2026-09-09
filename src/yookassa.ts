import { randomUUID } from 'node:crypto'
import { config } from './config.js'

const auth = 'Basic ' + Buffer.from(`${config.yookassa.shopId}:${config.yookassa.secretKey}`).toString('base64')

export interface YkResult {
  status: number
  data: any
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown, idempotenceKey?: string): Promise<YkResult> {
  const headers: Record<string, string> = { Authorization: auth }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    // Idempotence-Key обязателен для POST у ЮKassa. Пробрасываем ключ вызывающего
    // (сквозная идемпотентность), иначе — генерим свой.
    headers['Idempotence-Key'] = idempotenceKey || randomUUID()
  }
  const res = await fetch(`${config.yookassa.apiBase}/v3/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let data: any = null
  const text = await res.text()
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data }
}

export const yookassa = {
  createPayment: (payload: unknown, idempotenceKey?: string) => call('POST', 'payments', payload, idempotenceKey),
  getPayment: (id: string) => call('GET', `payments/${encodeURIComponent(id)}`),
  createRefund: (payload: unknown, idempotenceKey?: string) => call('POST', 'refunds', payload, idempotenceKey)
}
