import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(__dirname, '../../../.env') });

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
}

export interface AppConfig {
  databaseUrl: string;
  port: number;
  webOrigin: string;
  cookieSecure: boolean;
  presenceStaleSeconds: number;
  continuityWindowHours: number;
  sessionHours: number;
  outboundMaxAttempts: number;
  /** An unsent reservation older than this is revalidated before its first transmission. */
  revalidateAfterSeconds: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  const presenceStaleSeconds = int('PRESENCE_STALE_SECONDS', 60);
  if (presenceStaleSeconds < 5) throw new Error('PRESENCE_STALE_SECONDS must be at least 5');
  return {
    databaseUrl,
    port: int('API_PORT', 4000),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    presenceStaleSeconds,
    continuityWindowHours: int('CONTINUITY_WINDOW_HOURS', 24),
    sessionHours: 12,
    outboundMaxAttempts: 8,
    revalidateAfterSeconds: 300,
    ...overrides,
  };
}
