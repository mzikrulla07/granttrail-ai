/** The six subaward data elements GrantTrail extracts and reports. */
export const FIELD_NAMES = [
  'subrecipientName',
  'uei',
  'amount',
  'awardDate',
  'placeOfPerformance',
  'projectDescription',
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

export const FIELD_LABELS: Record<FieldName, string> = {
  subrecipientName: 'Subrecipient name',
  uei: 'Unique Entity ID (UEI)',
  amount: 'Subaward amount',
  awardDate: 'Award date',
  placeOfPerformance: 'Place of performance',
  projectDescription: 'Project description',
};

/** Typed DB column that holds the normalised value of each field. */
export const FIELD_COLUMNS: Record<FieldName, string> = {
  subrecipientName: 'subrecipient_name',
  uei: 'uei',
  amount: 'amount',
  awardDate: 'award_date',
  placeOfPerformance: 'place_of_performance',
  projectDescription: 'project_description',
};

export type FieldValues = Record<FieldName, string | null>;

export function isFieldName(v: string): v is FieldName {
  return (FIELD_NAMES as readonly string[]).includes(v);
}

export function emptyFieldValues(): FieldValues {
  return Object.fromEntries(FIELD_NAMES.map((f) => [f, null])) as FieldValues;
}

/** Trim; treat blank strings as missing. */
export function cleanValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length === 0 ? null : s;
}
