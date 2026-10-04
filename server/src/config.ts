/**
 * Centralised, validated configuration.
 *
 * All secrets come from environment variables (see /.env.example). Nothing in
 * this file is ever sent to the browser — the client only receives the
 * non-sensitive "mode" flags exposed by GET /api/health.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (works from both server/src and server/dist). */
export const PROJECT_ROOT = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim().toLowerCase())
  .pipe(z.enum(['', 'true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Opt-in for a public classroom demo (e.g. Elastic Beanstalk without Cognito):
   * allows demo users in production, forces simulated AI so no API key is ever
   * used, and shows a public-demo warning in the UI.
   */
  PUBLIC_DEMO: bool.default(false),
  /** Send HSTS + upgrade-insecure-requests. Defaults to true in production; set false when served over plain HTTP. */
  FORCE_HTTPS: z.preprocess(emptyToUndefined, bool.optional()),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  DATABASE_URL: optionalString,
  PGLITE_DATA_DIR: z.string().default('./.data/pglite'),
  DATABASE_SSL: bool.default(false),
  AUTO_SEED: z.preprocess(emptyToUndefined, bool.default(true)),

  AI_MODE: z.preprocess(emptyToUndefined, z.enum(['auto', 'demo', 'claude']).default('auto')),
  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: z.preprocess(emptyToUndefined, z.string().default('claude-sonnet-5')),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(5_000).max(500_000).default(120_000),

  STORAGE_DRIVER: z.preprocess(emptyToUndefined, z.enum(['local', 's3']).default('local')),
  LOCAL_STORAGE_DIR: z.string().default('./storage/uploads'),
  AWS_REGION: z.preprocess(emptyToUndefined, z.string().default('us-east-1')),
  S3_BUCKET: optionalString,
  S3_KMS_KEY_ID: optionalString,

  AUTH_MODE: z.preprocess(emptyToUndefined, z.enum(['dev', 'cognito']).default('dev')),
  COGNITO_USER_POOL_ID: optionalString,
  COGNITO_CLIENT_ID: optionalString,

  MAX_UPLOAD_MB: z.coerce.number().min(1).max(50).default(10),
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(10).default(1500),
  UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),

  REPORTING_THRESHOLD: z.coerce.number().min(0).default(30_000),
  DUE_SOON_DAYS: z.coerce.number().int().min(1).max(120).default(30),
  LOW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),

  PRIME_AWARDEE_NAME: z.preprocess(emptyToUndefined, z.string().default('Riverbend Housing Coalition')),
  PRIME_AWARD_ID: z.preprocess(emptyToUndefined, z.string().default('RHC-DEMO-FAIN-0001')),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  publicDemo: boolean;
  forceHttps: boolean;
  port: number;
  clientOrigin: string;
  db: { url?: string; pgliteDataDir: string; ssl: boolean; autoSeed: boolean };
  ai: {
    mode: 'demo' | 'claude';
    requestedMode: Env['AI_MODE'];
    apiKey?: string;
    model: string;
    timeoutMs: number;
    maxInputChars: number;
  };
  storage: {
    driver: 'local' | 's3';
    localDir: string;
    awsRegion: string;
    s3Bucket?: string;
    s3KmsKeyId?: string;
  };
  auth: { mode: 'dev' | 'cognito'; cognitoUserPoolId?: string; cognitoClientId?: string };
  limits: {
    maxUploadBytes: number;
    rateLimitWindowMs: number;
    rateLimitMax: number;
    uploadRateLimitMax: number;
  };
  rules: RulesConfig;
  export: { primeAwardeeName: string; primeAwardId: string };
}

/** Deterministic compliance-rule parameters, injectable for tests. */
export interface RulesConfig {
  reportingThreshold: number;
  dueSoonDays: number;
  lowConfidenceThreshold: number;
}

export const DEFAULT_RULES: RulesConfig = {
  reportingThreshold: 30_000,
  dueSoonDays: 30,
  lowConfidenceThreshold: 0.75,
};

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only variable names and messages are printed — never values.
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;

  let aiMode: 'demo' | 'claude';
  if (e.PUBLIC_DEMO && e.AI_MODE === 'claude') {
    throw new Error('PUBLIC_DEMO=true always uses simulated extraction; remove AI_MODE=claude.');
  }
  if (e.PUBLIC_DEMO) {
    aiMode = 'demo'; // never spend API credits on an unauthenticated public demo
  } else if (e.AI_MODE === 'claude') {
    if (!e.ANTHROPIC_API_KEY) throw new Error('AI_MODE=claude requires ANTHROPIC_API_KEY to be set.');
    aiMode = 'claude';
  } else if (e.AI_MODE === 'demo') {
    aiMode = 'demo';
  } else {
    aiMode = e.ANTHROPIC_API_KEY ? 'claude' : 'demo';
  }

  if (e.NODE_ENV === 'production' && e.AUTH_MODE === 'dev' && !e.PUBLIC_DEMO) {
    throw new Error(
      'AUTH_MODE=dev is not permitted when NODE_ENV=production. Configure Amazon Cognito, or set PUBLIC_DEMO=true for a fictional-data demo.',
    );
  }
  if (e.AUTH_MODE === 'cognito' && (!e.COGNITO_USER_POOL_ID || !e.COGNITO_CLIENT_ID)) {
    throw new Error('AUTH_MODE=cognito requires COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID.');
  }
  if (e.STORAGE_DRIVER === 's3' && !e.S3_BUCKET) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET.');
  }

  return {
    env: e.NODE_ENV,
    publicDemo: e.PUBLIC_DEMO,
    forceHttps: e.FORCE_HTTPS ?? e.NODE_ENV === 'production',
    port: e.PORT,
    clientOrigin: e.CLIENT_ORIGIN,
    db: {
      url: e.DATABASE_URL,
      pgliteDataDir: resolveFromRoot(e.PGLITE_DATA_DIR),
      ssl: e.DATABASE_SSL,
      autoSeed: e.AUTO_SEED,
    },
    ai: {
      mode: aiMode,
      requestedMode: e.AI_MODE,
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.CLAUDE_MODEL,
      timeoutMs: e.AI_TIMEOUT_MS,
      maxInputChars: e.AI_MAX_INPUT_CHARS,
    },
    storage: {
      driver: e.STORAGE_DRIVER,
      localDir: resolveFromRoot(e.LOCAL_STORAGE_DIR),
      awsRegion: e.AWS_REGION,
      s3Bucket: e.S3_BUCKET,
      s3KmsKeyId: e.S3_KMS_KEY_ID,
    },
    auth: {
      mode: e.AUTH_MODE,
      cognitoUserPoolId: e.COGNITO_USER_POOL_ID,
      cognitoClientId: e.COGNITO_CLIENT_ID,
    },
    limits: {
      maxUploadBytes: Math.round(e.MAX_UPLOAD_MB * 1024 * 1024),
      rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MINUTES * 60_000,
      rateLimitMax: e.RATE_LIMIT_MAX_REQUESTS,
      uploadRateLimitMax: e.UPLOAD_RATE_LIMIT_MAX,
    },
    rules: {
      reportingThreshold: e.REPORTING_THRESHOLD,
      dueSoonDays: e.DUE_SOON_DAYS,
      lowConfidenceThreshold: e.LOW_CONFIDENCE_THRESHOLD,
    },
    export: { primeAwardeeName: e.PRIME_AWARDEE_NAME, primeAwardId: e.PRIME_AWARD_ID },
  };
}
