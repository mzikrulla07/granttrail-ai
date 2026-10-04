/**
 * Renders FICTIONAL subaward agreement PDFs for demo data, samples and tests.
 * All organisations, people and identifiers are invented.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface AgreementSpec {
  agreementNumber: string;
  /** 'labeled' = clean labelled fields; 'narrative' = values buried in prose (lower-confidence extraction) */
  style: 'labeled' | 'narrative';
  subrecipientName: string;
  uei?: string | null;
  amount?: string | null;
  awardDate?: string | null;
  placeOfPerformance?: string | null;
  projectDescription?: string | null;
  periodOfPerformance: string;
  subrecipientAddress: string;
  signatory: string;
}

const PAGE = { w: 612, h: 792, margin: 64 };

class Writer {
  private page!: PDFPage;
  private y = 0;
  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  private newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - PAGE.margin;
    this.page.drawText('FICTIONAL DEMONSTRATION DOCUMENT — NOT A REAL AGREEMENT', {
      x: PAGE.margin,
      y: 28,
      size: 7,
      font: this.font,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  private ensure(h: number) {
    if (this.y - h < PAGE.margin) this.newPage();
  }

  line(text: string, opts: { size?: number; bold?: boolean; gap?: number; indent?: number } = {}) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.bold : this.font;
    const maxW = PAGE.w - PAGE.margin * 2 - (opts.indent ?? 0);
    const words = text.split(/\s+/);
    let current = '';
    const lines: string[] = [];
    for (const w of words) {
      const trial = current ? `${current} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) > maxW && current) {
        lines.push(current);
        current = w;
      } else current = trial;
    }
    if (current) lines.push(current);
    for (const l of lines) {
      this.ensure(size + 4);
      this.page.drawText(l, { x: PAGE.margin + (opts.indent ?? 0), y: this.y, size, font });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 0;
  }

  space(h = 10) {
    this.y -= h;
  }

  rule() {
    this.ensure(8);
    this.page.drawLine({
      start: { x: PAGE.margin, y: this.y + 4 },
      end: { x: PAGE.w - PAGE.margin, y: this.y + 4 },
      thickness: 0.6,
      color: rgb(0.6, 0.6, 0.6),
    });
    this.y -= 8;
  }
}

export async function renderAgreementPdf(spec: AgreementSpec): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Subaward Agreement ${spec.agreementNumber}`);
  doc.setAuthor('Riverbend Housing Coalition (fictional)');
  doc.setCreator('GrantTrail AI demo generator');
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold);

  w.line('RIVERBEND HOUSING COALITION', { size: 15, bold: true });
  w.line('Federal Subaward Agreement', { size: 12, bold: true, gap: 2 });
  w.line(`Agreement No. ${spec.agreementNumber}`, { size: 10 });
  w.line('Assistance Listing 14.267 — Continuum of Care Program (pass-through funds)', { size: 10, gap: 4 });
  w.rule();

  if (spec.style === 'labeled') {
    w.line('Section 1. Parties', { bold: true, gap: 2 });
    w.line(
      'This Subaward Agreement is made between Riverbend Housing Coalition ("Pass-Through Entity") and the organization identified below ("Subrecipient").',
      { gap: 6 },
    );
    w.line(`Subrecipient Legal Name: ${spec.subrecipientName}`);
    if (spec.uei) w.line(`Unique Entity ID (UEI): ${spec.uei}`);
    w.line(`Subrecipient Address: ${spec.subrecipientAddress}`, { gap: 10 });

    w.line('Section 2. Award Information', { bold: true, gap: 2 });
    if (spec.amount) w.line(`Subaward Amount: ${spec.amount}`);
    if (spec.awardDate) w.line(`Award Date: ${spec.awardDate}`);
    w.line(`Period of Performance: ${spec.periodOfPerformance}`);
    if (spec.placeOfPerformance) w.line(`Place of Performance: ${spec.placeOfPerformance}`);
    w.space(10);

    w.line('Section 3. Project Description', { bold: true, gap: 2 });
    if (spec.projectDescription) w.line(`Project Description: ${spec.projectDescription}`);
    w.space(12);
  } else {
    w.line('Section 1. Agreement', { bold: true, gap: 2 });
    const dateClause = spec.awardDate ? `, effective ${spec.awardDate},` : '';
    const ueiClause = spec.uei ? ` (UEI ${spec.uei})` : '';
    w.line(
      `This agreement${dateClause} is entered into by Riverbend Housing Coalition and ${spec.subrecipientName}${ueiClause} (the "Subrecipient"), located at ${spec.subrecipientAddress}.`,
      { gap: 8 },
    );
    w.line('Section 2. Funding', { bold: true, gap: 2 });
    w.line(
      spec.amount
        ? `The Pass-Through Entity agrees to reimburse allowable costs in an amount not to exceed ${spec.amount} for the period ${spec.periodOfPerformance}.`
        : `The Pass-Through Entity agrees to reimburse allowable costs for the period ${spec.periodOfPerformance} in the amount set out in the approved budget.`,
      { gap: 8 },
    );
    w.line('Section 3. Scope of Work', { bold: true, gap: 2 });
    if (spec.projectDescription) w.line(spec.projectDescription);
    if (spec.placeOfPerformance) w.line(`Services will be delivered in ${spec.placeOfPerformance}.`);
    w.space(12);
  }

  w.line('Section 4. Reporting and Compliance', { bold: true, gap: 2 });
  w.line(
    'The Subrecipient shall comply with 2 CFR Part 200 and shall provide programmatic and financial reports as requested by the Pass-Through Entity. The Pass-Through Entity will report this subaward as required by the Federal Funding Accountability and Transparency Act.',
    { gap: 8 },
  );
  w.line('Section 5. Signatures', { bold: true, gap: 2 });
  w.line('For Riverbend Housing Coalition: Executive Director (signature on file)');
  w.line(`For the Subrecipient: ${spec.signatory} (signature on file)`);

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
