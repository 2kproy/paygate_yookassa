import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

db.exec(`
CREATE TABLE IF NOT EXISTS redirect_token (
  token        TEXT PRIMARY KEY,
  payment_id   TEXT,
  order_id     TEXT,
  return_url   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | succeeded | canceled
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  succeeded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_token_payment ON redirect_token(payment_id);

-- Маппинг платёж → исходные metadata суб-мерчанта. В ЮKassa уходит только
-- непрозрачный ref, а на обратном пути (вебхук/перепрос статуса) paygate
-- восстанавливает оригинал — ЮKassa не видит telegram_id/тариф и пр.
CREATE TABLE IF NOT EXISTS payment_meta (
  payment_id TEXT PRIMARY KEY,
  ref        TEXT,
  meta_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_delivery (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id      TEXT,
  event           TEXT,
  body            TEXT NOT NULL,                   -- сырое тело ЮKassa (форвардим дословно)
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  delivered_at    INTEGER,
  dead            INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wh_due ON webhook_delivery(dead, delivered_at, next_attempt_at);
`)

export const nowSec = (): number => Math.floor(Date.now() / 1000)

export interface RedirectToken {
  token: string
  payment_id: string | null
  order_id: string | null
  return_url: string
  status: 'pending' | 'succeeded' | 'canceled'
  created_at: number
  expires_at: number
  succeeded_at: number | null
}

export interface WebhookDelivery {
  id: number
  payment_id: string | null
  event: string | null
  body: string
  attempts: number
  next_attempt_at: number
  delivered_at: number | null
  dead: number
  last_error: string | null
  created_at: number
}
