export type Severity = 'PASS' | 'WARNING' | 'ERROR';
export type SubawardStatus = 'awaiting_review' | 'approved' | 'reported';
export type Timeliness = 'on_track' | 'due_soon' | 'overdue' | 'reported' | 'unknown';
export type ListFilter = 'all' | 'due_soon' | 'overdue' | 'awaiting_review' | 'approved' | 'reported';
export type FieldName =
  | 'subrecipientName'
  | 'uei'
  | 'amount'
  | 'awardDate'
  | 'placeOfPerformance'
  | 'projectDescription';

export const FIELD_ORDER: FieldName[] = [
  'subrecipientName',
  'uei',
  'amount',
  'awardDate',
  'placeOfPerformance',
  'projectDescription',
];

export interface Health {
  status: string;
  demoMode: boolean;
  publicDemo?: boolean;
  modes: { ai: 'demo' | 'claude'; aiModel: string; database: string; storage: string; auth: 'dev' | 'cognito' };
  limits: { maxUploadMb: number };
  rules: { reportingThreshold: number; dueSoonDays: number; lowConfidenceThreshold: number };
}

export type Permission =
  | 'subaward:read'
  | 'subaward:upload'
  | 'subaward:edit'
  | 'subaward:approve'
  | 'subaward:export'
  | 'subaward:report'
  | 'audit:read';

export interface Me {
  id: string;
  email: string;
  fullName: string;
  role: string;
  roleLabel: string;
  permissions: Permission[];
}

export interface DemoUser {
  email: string;
  fullName: string;
  role: string;
  roleLabel: string;
}

export interface ValidationCheck {
  code: string;
  field: FieldName | null;
  severity: Severity;
  message: string;
  blocking: boolean;
}

export interface ValidationReport {
  status: Severity;
  checks: ValidationCheck[];
  fieldStatus: Record<FieldName, Severity>;
  normalized: Record<FieldName, string | null>;
  dueDate: string | null;
  daysUntilDue: number | null;
  timeliness: Timeliness;
  reportingRequired: boolean | null;
  blockingErrorCount: number;
  warningCount: number;
  canApprove: boolean;
}

export interface SubawardSummary {
  id: string;
  status: SubawardStatus;
  subrecipientName: string | null;
  uei: string | null;
  amount: string | null;
  awardDate: string | null;
  dueDate: string | null;
  daysUntilDue: number | null;
  timeliness: Timeliness;
  validationStatus: Severity;
  errorCount: number;
  warningCount: number;
  extractionMode: 'demo' | 'claude';
  updatedAt: string;
}

export interface FieldDto {
  name: FieldName;
  label: string;
  value: string | null;
  aiValue: string | null;
  confidence: number;
  sourceExcerpt: string | null;
  isHumanEdited: boolean;
  editedAt: string | null;
  editedBy: string | null;
}

export interface SubawardDetail extends SubawardSummary {
  fields: FieldDto[];
  validation: ValidationReport;
  extraction: { mode: 'demo' | 'claude'; model: string | null; status: 'completed' | 'failed' };
  document: {
    id: string;
    filename: string;
    sizeBytes: number;
    pageCount: number | null;
    sha256: string;
    uploadedAt: string;
    uploadedBy: string;
    text: string;
  };
  approval: null | { approvedBy: string; approvedAt: string; attestation: string; validationStatus: string };
  exportedAt: string | null;
  reportedAt: string | null;
  createdAt: string;
  attestationText: string;
}

export interface DashboardData {
  totals: {
    total: number;
    dueSoon: number;
    overdue: number;
    awaitingReview: number;
    approved: number;
    reported: number;
    approvedOrReported: number;
    totalAmount: string;
    withErrors: number;
  };
  nextDeadline: string | null;
  rules: { reportingThreshold: number; dueSoonDays: number; lowConfidenceThreshold: number };
}

export interface AuditEvent {
  id: string;
  subawardId: string | null;
  subrecipientName: string | null;
  eventType: string;
  actor: string;
  actorName: string;
  timestamp: string;
  details: Record<string, unknown>;
}
