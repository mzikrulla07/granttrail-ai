/**
 * Client-side pre-checks for uploads. These are for fast, friendly feedback
 * only — the server re-validates everything (type by magic bytes, size, text).
 */
export interface FileCheck {
  ok: boolean;
  message?: string;
}

export function checkFileBasics(file: { name: string; size: number; type: string }, maxMb: number): FileCheck {
  if (!/\.pdf$/i.test(file.name) || (file.type && !['application/pdf', 'application/x-pdf'].includes(file.type))) {
    return { ok: false, message: 'Only PDF files can be uploaded. Choose a signed subaward agreement saved as .pdf.' };
  }
  if (file.size === 0) return { ok: false, message: 'This file is empty. Choose a different PDF.' };
  if (file.size > maxMb * 1024 * 1024) {
    return { ok: false, message: `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The maximum size is ${maxMb} MB.` };
  }
  return { ok: true };
}

/** Verify the file starts with the PDF signature (%PDF-). */
export async function hasPdfSignature(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let i = 0; i <= head.length - sig.length; i++) {
    if (sig.every((b, j) => head[i + j] === b)) return true;
  }
  return false;
}
