import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { FIELD_NAMES, type FieldName } from '../domain/fields.js';
import { authenticate, currentUser, permissionsFor, requirePermission, ROLE_LABELS } from '../auth/index.js';
import { AppError } from '../http/errors.js';
import { parseInput } from '../http/validate.js';
import { AUDIT_EVENT_TYPES } from '../services/audit.js';
import type { SubawardService } from '../services/subawardService.js';

const IdParam = z.object({ id: z.uuid({ message: 'Invalid record id.' }) });

const FieldPatch = z
  .object(
    Object.fromEntries(FIELD_NAMES.map((f) => [f, z.string().max(5000, 'Value is too long.').nullable().optional()])) as Record<
      FieldName,
      z.ZodOptional<z.ZodNullable<z.ZodString>>
    >,
  )
  .strict();

const SaveDraftBody = z.object({ fields: FieldPatch }).strict();
const ApproveBody = z.object({ attestation: z.literal(true, { message: 'Attestation is required.' }), fields: FieldPatch.optional() }).strict();
const ReportBody = z.object({ reference: z.string().trim().max(200).optional() }).strict();
const ListQuery = z.object({
  filter: z.enum(['all', 'due_soon', 'overdue', 'awaiting_review', 'approved', 'reported']).default('all'),
  search: z.string().max(100).optional(),
});
const AuditQuery = z.object({
  subawardId: z.uuid().optional(),
  eventType: z.enum(AUDIT_EVENT_TYPES as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export function apiRouter(deps: { db: Db; config: AppConfig; service: SubawardService }): Router {
  const { db, config, service } = deps;
  const r = Router();

  // ---- public ------------------------------------------------------------
  r.get('/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({
      status: 'ok',
      demoMode: config.ai.mode === 'demo',
      publicDemo: config.publicDemo,
      modes: {
        ai: config.ai.mode,
        aiModel: config.ai.mode === 'claude' ? config.ai.model : 'demo-rule-based-simulator',
        database: db.engine,
        storage: config.storage.driver,
        auth: config.auth.mode,
      },
      limits: { maxUploadMb: Math.round(config.limits.maxUploadBytes / 1024 / 1024) },
      rules: config.rules,
    });
  });

  // Dev-mode user list for the "Signed in as" switcher (never exposed with Cognito).
  r.get('/auth/demo-users', async (_req, res) => {
    if (config.auth.mode !== 'dev') throw new AppError(404, 'NOT_FOUND', 'Not available.');
    const { rows } = await db.query<{ email: string; full_name: string; role: keyof typeof ROLE_LABELS }>(
      `SELECT email, full_name, role FROM users WHERE is_active = true ORDER BY role, full_name`,
    );
    res.json({ users: rows.map((u) => ({ email: u.email, fullName: u.full_name, role: u.role, roleLabel: ROLE_LABELS[u.role] })) });
  });

  // ---- authenticated -------------------------------------------------------
  r.use(authenticate(db, config));

  r.get('/me', (_req, res) => {
    const u = currentUser(res);
    res.json({ user: { ...u, roleLabel: ROLE_LABELS[u.role], permissions: permissionsFor(u.role) } });
  });

  r.get('/dashboard', requirePermission('subaward:read'), async (_req, res) => {
    res.json(await service.dashboard());
  });

  r.get('/subawards', requirePermission('subaward:read'), async (req, res) => {
    const q = parseInput(ListQuery, req.query, 'filter');
    res.json({ items: await service.list(q.filter, q.search) });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.limits.maxUploadBytes, files: 1, fields: 5, parts: 6 },
    fileFilter: (_req, file, cb) => {
      const okName = /\.pdf$/i.test(file.originalname);
      const okType = ['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(file.mimetype);
      if (!okName || !okType) return cb(new AppError(415, 'NOT_A_PDF', 'Only PDF files (.pdf) can be uploaded.'));
      cb(null, true);
    },
  });
  const uploadLimiter = rateLimit({
    windowMs: config.limits.rateLimitWindowMs,
    limit: config.limits.uploadRateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'RATE_LIMITED', 'Too many uploads in a short period. Please wait a few minutes and try again.')),
  });

  r.post('/subawards/upload', requirePermission('subaward:upload'), uploadLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) throw new AppError(400, 'NO_FILE', 'Choose a PDF agreement to upload.');
    const result = await service.ingestDocument({ buffer: req.file.buffer, originalName: req.file.originalname, user: currentUser(res) });
    const detail = await service.get(result.subawardId);
    res.status(201).json({ subaward: detail });
  });

  r.get('/subawards/:id', requirePermission('subaward:read'), async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'record id');
    res.json({ subaward: await service.get(id) });
  });

  r.get('/subawards/:id/document', requirePermission('subaward:read'), async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'record id');
    const { buffer, filename } = await service.getDocumentFile(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    // Allow this one response to be framed by our own origin for the PDF viewer.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; sandbox");
    res.removeHeader('X-Frame-Options');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.send(buffer);
  });

  r.post('/subawards/:id/validate-preview', requirePermission('subaward:read'), async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'record id');
    const body = parseInput(SaveDraftBody, req.body, 'fields');
    res.json({ validation: await service.previewValidation(id, body.fields) });
  });

  r.post('/subawards/:id/validate', requirePermission('subaward:edit'), async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'record id');
    res.json({ subaward: await service.revalidate(id, currentUser(res)) });
  });

  r.patch('/subawards/:id', requirePermission('subaward:edit'), async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'record id');
    const body = parseInput(SaveDraftBody, req.body, 'fields');
    res.json({ subaward: await service.saveDraft(id, body.fields, currentUser(res)) });
  });

  r.post('/subawards/:id/approve', requirePermission('subaward:approve'), async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'record id');
    const body = parseInput(ApproveBody, req.body, 'approval');
    res.json({ subaward: await service.approve(id, body, currentUser(res)) });
  });

  r.post('/subawards/:id/mark-reported', requirePermission('subaward:report'), async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'record id');
    const body = parseInput(ReportBody, req.body ?? {}, 'request');
    res.json({ subaward: await service.markReported(id, body, currentUser(res)) });
  });

  const sendCsv = (res: import('express').Response, out: { filename: string; csv: string; count: number }) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Count', String(out.count));
    res.send(out.csv);
  };

  r.get('/subawards/:id/export.csv', requirePermission('subaward:export'), async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'record id');
    sendCsv(res, await service.exportCsv([id], currentUser(res)));
  });

  r.get('/exports/approved.csv', requirePermission('subaward:export'), async (_req, res) => {
    sendCsv(res, await service.exportCsv('all_approved', currentUser(res)));
  });

  r.get('/audit-events', requirePermission('audit:read'), async (req, res) => {
    const q = parseInput(AuditQuery, req.query, 'filter');
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.subawardId) {
      params.push(q.subawardId);
      where.push(`e.subaward_id = $${params.length}`);
    }
    if (q.eventType) {
      params.push(q.eventType);
      where.push(`e.event_type = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM audit_events e ${whereSql}`, params);
    params.push(q.limit, q.offset);
    const { rows } = await db.query<{
      id: string;
      subaward_id: string | null;
      event_type: string;
      actor: string;
      timestamp: string | Date;
      details: unknown;
      subrecipient_name: string | null;
      actor_name: string | null;
    }>(
      `SELECT e.id, e.subaward_id, e.event_type, e.actor, e."timestamp", e.details, s.subrecipient_name, u.full_name AS actor_name
         FROM audit_events e
         LEFT JOIN subawards s ON s.id = e.subaward_id
         LEFT JOIN users u ON u.id = e.actor_user_id
         ${whereSql}
        ORDER BY e."timestamp" DESC, e.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({
      total: Number(total.rows[0]?.n ?? 0),
      items: rows.map((e) => ({
        id: e.id,
        subawardId: e.subaward_id,
        subrecipientName: e.subrecipient_name,
        eventType: e.event_type,
        actor: e.actor,
        actorName: e.actor_name ?? (e.actor === 'system' ? 'GrantTrail system' : e.actor),
        timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : new Date(e.timestamp).toISOString(),
        details: typeof e.details === 'string' ? JSON.parse(e.details) : e.details,
      })),
    });
  });

  return r;
}
