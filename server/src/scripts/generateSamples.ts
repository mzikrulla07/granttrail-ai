/**
 * Writes fictional sample agreements to /samples for trying the upload
 * workflow, plus matching ground-truth labels for the evaluation harness
 * (tests/evaluation/labels/samples.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { todayIso } from '../domain/parsing.js';
import type { LabeledAgreement } from '../evaluation/scoring.js';
import { renderAgreementPdf } from '../samples/agreementPdf.js';
import { buildSampleAgreements } from '../samples/demoData.js';

const outDir = path.join(PROJECT_ROOT, 'samples');
fs.mkdirSync(outDir, { recursive: true });
const labels: LabeledAgreement[] = [];

for (const s of buildSampleAgreements(todayIso())) {
  const pdf = await renderAgreementPdf(s.spec);
  fs.writeFileSync(path.join(outDir, s.filename), pdf);
  labels.push({
    file: `samples/${s.filename}`,
    notes: `Fictional sample. ${s.description}`,
    expected: {
      subrecipientName: s.spec.subrecipientName,
      uei: s.spec.uei ?? null,
      amount: s.spec.amount ?? null,
      awardDate: s.spec.awardDate ?? null,
      placeOfPerformance: s.spec.placeOfPerformance ?? null,
      projectDescription: s.spec.projectDescription ?? null,
    },
  });
  console.log(`wrote samples/${s.filename} — ${s.description}`);
}

const labelFile = path.join(PROJECT_ROOT, 'tests', 'evaluation', 'labels', 'samples.json');
fs.mkdirSync(path.dirname(labelFile), { recursive: true });
fs.writeFileSync(labelFile, JSON.stringify(labels, null, 2) + '\n');
console.log('wrote tests/evaluation/labels/samples.json (ground truth for npm run eval)');
