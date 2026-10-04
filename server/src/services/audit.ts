import type { AuthUser } from '../auth/index.js';
import type { Queryable } from '../db/index.js';

export type AuditEventType =
  | 'document_uploaded'
  | 'ai_extraction_completed'
  | 'ai_extraction_failed'
  | 'field_edited'
  | 'validation_performed'
  | 'record_approved'
  | 'export_generated'
  | 'status_changed';

export const AUDIT_EVENT_TYPES: AuditEventType[] = [
  'document_uploaded',
  'ai_extraction_completed',
  'ai_extraction_failed',
  'field_edited',
  'validation_performed',
  'record_approved',
  'export_generated',
  'status_changed',
];

/** Append an audit event. The table rejects UPDATE/DELETE at the database level. */
export async function recordAudit(
  q: Queryable,
  event: { subawardId: string | null; type: AuditEventType; actor: AuthUser | 'system'; details?: Record<string, unknown> },
): Promise<void> {
  const actorLabel = event.actor === 'system' ? 'system' : event.actor.email;
  const actorId = event.actor === 'system' ? null : event.actor.id;
  await q.query(
    `INSERT INTO audit_events (subaward_id, event_type, actor, actor_user_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [event.subawardId, event.type, actorLabel, actorId, JSON.stringify(event.details ?? {})],
  );
}
