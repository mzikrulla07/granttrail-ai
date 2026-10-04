/**
 * FICTIONAL demo portfolio for Riverbend Housing Coalition.
 * Dates are computed relative to "today" so the dashboard always shows an
 * overdue record, a due-soon record, etc., whenever the demo is run.
 * No real organisations, people, or identifiers are used.
 */
import type { AgreementSpec } from './agreementPdf.js';

export interface DemoUser {
  email: string;
  fullName: string;
  role: 'grants_specialist' | 'finance_director' | 'partner_agency' | 'admin';
}

export const DEMO_USERS: DemoUser[] = [
  { email: 'dana.whitfield@riverbend.example', fullName: 'Dana Whitfield', role: 'grants_specialist' },
  { email: 'luis.ortega@riverbend.example', fullName: 'Luis Ortega', role: 'grants_specialist' },
  { email: 'marcus.ellery@riverbend.example', fullName: 'Marcus Ellery', role: 'finance_director' },
  { email: 'avery.chen@riverbend.example', fullName: 'Avery Chen', role: 'admin' },
  { email: 'jordan.blake@harborlight.example', fullName: 'Jordan Blake', role: 'partner_agency' },
];

export type DemoOutcome = 'awaiting_review' | 'approved' | 'reported';

export interface DemoRecord {
  spec: AgreementSpec;
  outcome: DemoOutcome;
  filename: string;
  /** Field corrections a specialist makes before approval (recorded in the audit trail) */
  corrections?: Record<string, string>;
  approver?: string;
  note: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Date `monthsAgo` months before `today`, on `day` (clamped to a valid, non-future date). */
function monthDate(today: string, monthsAgo: number, day: number): { y: number; m: number; d: number } {
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let m = tm - monthsAgo;
  let y = ty;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let d = Math.min(day, lastDay);
  if (monthsAgo === 0) d = Math.min(d, td);
  return { y, m, d };
}
const long = (p: { y: number; m: number; d: number }) => `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
const us = (p: { y: number; m: number; d: number }) => `${String(p.m).padStart(2, '0')}/${String(p.d).padStart(2, '0')}/${p.y}`;
const period = (p: { y: number; m: number; d: number }) => `${long(p)} through ${MONTHS[(p.m + 10) % 12]} ${new Date(Date.UTC(p.y, p.m - 1 + 12, 0)).getUTCDate()}, ${p.m === 1 ? p.y : p.y + 1}`;

export function buildDemoRecords(today: string): DemoRecord[] {
  const d = (monthsAgo: number, day: number) => monthDate(today, monthsAgo, day);
  const yy = today.slice(0, 4);

  const a = d(2, 12);
  const b = d(1, 8);
  const c = d(0, 3);
  const e = d(1, 19);
  const f = d(1, 22);
  const g = d(0, 2);
  const h = d(1, 5);
  const i = d(3, 14);
  const j = d(4, 9);

  return [
    {
      filename: 'Maple-Street-Shelter-Subaward.pdf',
      outcome: 'awaiting_review',
      note: 'Overdue — awarded two months ago and still awaiting review',
      spec: {
        agreementNumber: `RHC-SA-${yy}-031`,
        style: 'labeled',
        subrecipientName: 'Maple Street Community Shelter, Inc.',
        uei: 'MS4K7TQ2LZ81',
        amount: '$185,000.00',
        awardDate: long(a),
        periodOfPerformance: period(a),
        placeOfPerformance: 'Riverbend, OH 45101',
        subrecipientAddress: '418 Maple Street, Riverbend, OH 45101',
        projectDescription:
          'Operate a 40-bed year-round emergency shelter for adults experiencing homelessness, including case management, housing navigation, and referral to rapid rehousing.',
        signatory: 'Executive Director, Maple Street Community Shelter',
      },
    },
    {
      filename: 'Harbor-Light-Tenant-Services-Agreement.pdf',
      outcome: 'awaiting_review',
      note: 'Due soon — report due at the end of this month',
      spec: {
        agreementNumber: `RHC-SA-${yy}-036`,
        style: 'labeled',
        subrecipientName: 'Harbor Light Tenant Services',
        uei: 'HL8R2W6NXC34',
        amount: '$92,500.00',
        awardDate: us(b),
        periodOfPerformance: period(b),
        placeOfPerformance: 'Port Lessing, OH 45144',
        subrecipientAddress: '77 Wharf Road, Port Lessing, OH 45144',
        projectDescription:
          'Provide tenancy-sustaining services and landlord mediation for 120 households at risk of eviction in the Port Lessing service area.',
        signatory: 'Program Director, Harbor Light Tenant Services',
      },
    },
    {
      filename: 'Northgate-Youth-Housing-Subaward.pdf',
      outcome: 'awaiting_review',
      note: 'Awaiting review — narrative agreement with low-confidence fields',
      spec: {
        agreementNumber: `RHC-SA-${yy}-041`,
        style: 'narrative',
        subrecipientName: 'Northgate Youth Housing Collaborative',
        uei: 'NY3P9D5KVB72',
        amount: '$250,000',
        awardDate: long(c),
        periodOfPerformance: period(c),
        placeOfPerformance: 'the Northgate and Elm Hollow neighborhoods of Riverbend, Ohio',
        subrecipientAddress: '1200 Northgate Avenue, Riverbend, OH 45103',
        projectDescription:
          'The Subrecipient will provide transitional housing with supportive services for youth ages 18 to 24 exiting foster care, including education and employment coaching.',
        signatory: 'Chief Executive Officer, Northgate Youth Housing Collaborative',
      },
    },
    {
      filename: 'Pine-Ridge-Rapid-Rehousing.pdf',
      outcome: 'awaiting_review',
      note: 'UEI validation error — the UEI contains the letter O and is only 11 characters',
      spec: {
        agreementNumber: `RHC-SA-${yy}-038`,
        style: 'labeled',
        subrecipientName: 'Pine Ridge Rapid Rehousing Network',
        uei: 'PR4O7XK2M9L',
        amount: '$147,800.00',
        awardDate: long(e),
        periodOfPerformance: period(e),
        placeOfPerformance: 'Pine Ridge, OH 45160',
        subrecipientAddress: '9 Ridgeview Court, Pine Ridge, OH 45160',
        projectDescription:
          'Deliver rapid rehousing assistance, including short-term rental assistance and housing stabilization case management, for 45 families with children.',
        signatory: 'Executive Director, Pine Ridge Rapid Rehousing Network',
      },
    },
    {
      filename: 'Riverside-Veterans-Transitional-Housing.pdf',
      outcome: 'approved',
      approver: 'dana.whitfield@riverbend.example',
      corrections: { placeOfPerformance: 'Riverbend, OH 45102' },
      note: 'Approved — specialist corrected an incomplete place of performance before approval',
      spec: {
        agreementNumber: `RHC-SA-${yy}-037`,
        style: 'labeled',
        subrecipientName: 'Riverside Veterans Transitional Housing',
        uei: 'RV6T3M8QHW25',
        amount: '$310,000.00',
        awardDate: long(f),
        periodOfPerformance: period(f),
        placeOfPerformance: 'Riverbend, Ohio',
        subrecipientAddress: '2250 River Road, Riverbend, OH 45102',
        projectDescription:
          'Operate 28 units of transitional housing for veterans experiencing homelessness, with on-site peer support and connection to permanent housing.',
        signatory: 'Executive Director, Riverside Veterans Transitional Housing',
      },
    },
    {
      filename: 'Oakmont-Rural-Housing-Partners.pdf',
      outcome: 'approved',
      approver: 'luis.ortega@riverbend.example',
      note: 'Approved — ready to export',
      spec: {
        agreementNumber: `RHC-SA-${yy}-042`,
        style: 'labeled',
        subrecipientName: 'Oakmont Rural Housing Partners',
        uei: 'KM2V7C4HPN93',
        amount: '$64,250.00',
        awardDate: long(g),
        periodOfPerformance: period(g),
        placeOfPerformance: 'Oakmont, OH 45171',
        subrecipientAddress: '15 County Line Road, Oakmont, OH 45171',
        projectDescription:
          'Provide homelessness prevention assistance and housing counseling to rural households in Oakmont and surrounding townships.',
        signatory: 'Board Chair, Oakmont Rural Housing Partners',
      },
    },
    {
      filename: 'Brookside-Tenant-Education.pdf',
      outcome: 'approved',
      approver: 'dana.whitfield@riverbend.example',
      note: 'Approved with warning — below the $30,000 reporting threshold',
      spec: {
        agreementNumber: `RHC-SA-${yy}-035`,
        style: 'labeled',
        subrecipientName: 'Brookside Tenant Education Program',
        uei: 'BT5N8K2RWD46',
        amount: '$18,500.00',
        awardDate: long(h),
        periodOfPerformance: period(h),
        placeOfPerformance: 'Brookside, OH 45120',
        subrecipientAddress: '301 Brook Lane, Brookside, OH 45120',
        projectDescription:
          'Deliver tenant rights and financial literacy workshops for households exiting emergency shelter into permanent housing.',
        signatory: 'Director, Brookside Tenant Education Program',
      },
    },
    {
      filename: 'Willow-Creek-Emergency-Housing.pdf',
      outcome: 'reported',
      approver: 'luis.ortega@riverbend.example',
      note: 'Reported',
      spec: {
        agreementNumber: `RHC-SA-${yy}-027`,
        style: 'labeled',
        subrecipientName: 'Willow Creek Emergency Housing',
        uei: 'WC9H4T6MZK18',
        amount: '$412,000.00',
        awardDate: long(i),
        periodOfPerformance: period(i),
        placeOfPerformance: 'Willow Creek, OH 45133',
        subrecipientAddress: '640 Creekside Drive, Willow Creek, OH 45133',
        projectDescription:
          'Provide emergency shelter and motel-voucher diversion for families with children, with housing-focused case management toward permanent placement.',
        signatory: 'Executive Director, Willow Creek Emergency Housing',
      },
    },
    {
      filename: 'Summit-County-Eviction-Prevention.pdf',
      outcome: 'reported',
      approver: 'dana.whitfield@riverbend.example',
      note: 'Reported',
      spec: {
        agreementNumber: `RHC-SA-${yy}-022`,
        style: 'labeled',
        subrecipientName: 'Summit County Eviction Prevention Project',
        uei: 'SC7L2P5XGQ64',
        amount: '$128,900.00',
        awardDate: long(j),
        periodOfPerformance: period(j),
        placeOfPerformance: 'Summit Falls, OH 45150',
        subrecipientAddress: '88 Courthouse Square, Summit Falls, OH 45150',
        projectDescription:
          'Provide one-time emergency rental assistance and legal aid referrals to prevent eviction for low-income renter households.',
        signatory: 'Managing Attorney, Summit County Eviction Prevention Project',
      },
    },
  ];
}

/** Sample agreements for trying the upload workflow (not pre-loaded). */
export function buildSampleAgreements(today: string): { filename: string; description: string; spec: AgreementSpec }[] {
  const lastMonth = monthDate(today, 1, 16);
  const thisMonth = monthDate(today, 0, 1);
  const yy = today.slice(0, 4);
  return [
    {
      filename: 'sample-01-cedar-hollow-clean.pdf',
      description: 'Clean, well-labelled agreement. Expect high confidence and PASS/WARNING validation.',
      spec: {
        agreementNumber: `RHC-SA-${yy}-043`,
        style: 'labeled',
        subrecipientName: 'Cedar Hollow Family Housing Alliance',
        uei: 'CH3W8N5KTR27',
        amount: '$176,400.00',
        awardDate: long(lastMonth),
        periodOfPerformance: period(lastMonth),
        placeOfPerformance: 'Cedar Hollow, OH 45115',
        subrecipientAddress: '52 Hollow Road, Cedar Hollow, OH 45115',
        projectDescription:
          'Provide permanent supportive housing and wraparound services for 30 households with a disabled head of household who have experienced chronic homelessness.',
        signatory: 'Executive Director, Cedar Hollow Family Housing Alliance',
      },
    },
    {
      filename: 'sample-02-lantern-house-bad-uei.pdf',
      description: 'UEI contains the letter "I" (invalid). Expect a blocking UEI error until corrected.',
      spec: {
        agreementNumber: `RHC-SA-${yy}-044`,
        style: 'labeled',
        subrecipientName: 'Lantern House Recovery Residences',
        uei: 'LH7I2Q9MXV51',
        amount: '$58,000.00',
        awardDate: long(lastMonth),
        periodOfPerformance: period(lastMonth),
        placeOfPerformance: 'Riverbend, OH 45104',
        subrecipientAddress: '19 Lantern Way, Riverbend, OH 45104',
        projectDescription:
          'Operate recovery-oriented transitional residences with peer mentoring and employment readiness services for adults leaving homelessness.',
        signatory: 'Executive Director, Lantern House Recovery Residences',
      },
    },
    {
      filename: 'sample-03-fairview-missing-fields.pdf',
      description: 'Narrative agreement with no UEI, no amount and vague location. Expect missing-field errors and low confidence.',
      spec: {
        agreementNumber: `RHC-SA-${yy}-045`,
        style: 'narrative',
        subrecipientName: 'Fairview Neighborhood Housing Services',
        uei: null,
        amount: null,
        awardDate: long(thisMonth),
        periodOfPerformance: period(thisMonth),
        placeOfPerformance: 'the Fairview district',
        subrecipientAddress: '700 Fairview Boulevard, Riverbend, OH 45105',
        projectDescription:
          'The Subrecipient will provide housing search assistance and security-deposit support to households exiting emergency shelter.',
        signatory: 'Executive Director, Fairview Neighborhood Housing Services',
      },
    },
  ];
}
