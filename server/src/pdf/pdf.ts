/**
 * Safe PDF handling.
 *  - Type is verified by magic bytes (%PDF-), not by the client-supplied
 *    filename or MIME type, which are trivially spoofed.
 *  - Files are processed from memory; the original filename is never used as
 *    a filesystem path.
 *  - Text is extracted server-side with pdf-parse.
 */
import crypto from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { AppError } from '../http/errors.js';

const PDF_MAGIC = Buffer.from('%PDF-');

export function isPdfBuffer(buf: Buffer): boolean {
  // Spec allows the header within the first 1024 bytes.
  const head = buf.subarray(0, 1024);
  return head.indexOf(PDF_MAGIC) !== -1;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Keep a display-safe filename: basename only, safe characters, bounded length. */
export function sanitizeFilename(name: string | undefined): string {
  const base = (name ?? 'agreement.pdf').split(/[\\/]/).pop() ?? 'agreement.pdf';
  const cleaned = base
    .normalize('NFKC')
    .replace(/[^\w.\- ()]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  const withExt = cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned || 'agreement'}.pdf`;
  return withExt;
}

export interface PdfText {
  text: string;
  pageCount: number;
}

export async function extractPdfText(buf: Buffer): Promise<PdfText> {
  if (!isPdfBuffer(buf)) {
    throw new AppError(415, 'NOT_A_PDF', 'The file is not a valid PDF document.');
  }
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    // pdf-parse inserts page markers like "-- 1 of 3 --"; remove them from analysis text.
    const text = result.text
      .replace(/\r\n?/g, '\n')
      .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, pageCount: result.total };
  } catch (err) {
    const name = (err as Error)?.name ?? '';
    if (name === 'PasswordException') {
      throw new AppError(422, 'PDF_ENCRYPTED', 'This PDF is password-protected. Upload an unlocked copy of the agreement.');
    }
    throw new AppError(422, 'PDF_UNREADABLE', 'The PDF could not be read. It may be damaged — try re-saving or re-exporting it.');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
