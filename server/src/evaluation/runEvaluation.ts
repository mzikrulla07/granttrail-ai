/**
 * Extraction accuracy evaluation.
 *
 *   npm run eval                 # uses AI_MODE from .env (Claude if a key is set, else demo)
 *   npm run eval -- demo         # force the demo simulator
 *
 * Reads every *.json label file in tests/evaluation/labels/ (arrays of
 * LabeledAgreement), extracts each referenced PDF with the configured
 * extractor, scores field-by-field, and writes JSON + Markdown reports to
 * tests/evaluation/reports/. Target: 20 labelled real-world agreements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeExtractor } from '../ai/claudeExtractor.js';
import { DemoExtractor } from '../ai/demoExtractor.js';
import type { Extractor } from '../ai/types.js';
import { loadConfig, PROJECT_ROOT } from '../config.js';
import { FIELD_LABELS, FIELD_NAMES } from '../domain/fields.js';
import { extractPdfText } from '../pdf/pdf.js';
import { scoreAgreement, summarize, type FieldScore, type LabeledAgreement } from './scoring.js';

export const TARGET_SET_SIZE = 20;
const EVAL_DIR = path.join(PROJECT_ROOT, 'tests', 'evaluation');

function loadLabels(): LabeledAgreement[] {
  const dir = path.join(EVAL_DIR, 'labels');
  const out: LabeledAgreement[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as LabeledAgreement[];
    out.push(...data);
  }
  return out;
}

const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);

async function main() {
  const config = loadConfig();
  // `npm run eval -- demo` (npm consumes --flags itself, so a bare word is used)
  const forceDemo = process.argv.slice(2).some((a) => a === 'demo' || a === '--demo');
  const extractor: Extractor =
    config.ai.mode === 'claude' && !forceDemo
      ? new ClaudeExtractor({ apiKey: config.ai.apiKey, model: config.ai.model, timeoutMs: config.ai.timeoutMs, maxInputChars: config.ai.maxInputChars })
      : new DemoExtractor(0);

  const labels = loadLabels();
  const available = labels.filter((l) => fs.existsSync(path.join(PROJECT_ROOT, l.file)));
  console.log(`Evaluation set: ${available.length} of ${labels.length} labelled agreements found (target ${TARGET_SET_SIZE}).`);
  console.log(`Extractor: ${extractor.mode === 'demo' ? 'DEMO simulator' : `Claude (${extractor.model})`}\n`);
  if (available.length === 0) {
    console.log('No agreements to evaluate. See tests/evaluation/README.md to add labelled agreements.');
    return;
  }

  const results: FieldScore[][] = [];
  const perDoc: { file: string; scores: FieldScore[] }[] = [];
  for (const l of available) {
    const buf = fs.readFileSync(path.join(PROJECT_ROOT, l.file));
    const { text } = await extractPdfText(buf);
    const extraction = await extractor.extract(text);
    const scores = scoreAgreement(l.expected, extraction.fields);
    results.push(scores);
    perDoc.push({ file: l.file, scores });
    const ok = scores.filter((s) => s.correct).length;
    console.log(`  ${ok}/6  ${l.file}`);
    for (const s of scores.filter((x) => !x.correct)) {
      console.log(`        ✗ ${s.field}: expected ${JSON.stringify(s.expected)}, got ${JSON.stringify(s.predicted)} (conf ${s.confidence})`);
    }
  }

  const summary = summarize(results, config.rules.lowConfidenceThreshold);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.join(EVAL_DIR, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const md = [
    `# Extraction evaluation — ${new Date().toISOString()}`,
    '',
    `* Extractor: ${extractor.mode === 'demo' ? 'DEMO simulator (not Claude)' : `Claude \`${extractor.model}\``}`,
    `* Agreements evaluated: ${summary.agreements} (target ${TARGET_SET_SIZE})`,
    `* Overall field accuracy: **${pct(summary.overallFieldAccuracy)}**`,
    `* Fully correct agreements: ${summary.fullyCorrectAgreements}/${summary.agreements}`,
    `* Precision of high-confidence values (≥ ${config.rules.lowConfidenceThreshold}): ${pct(summary.highConfidencePrecision)}`,
    `* Confident errors (wrong but high confidence): **${summary.confidentErrors}**`,
    `* Errors correctly flagged by low confidence / missing: ${summary.flaggedErrors}`,
    `* Hallucinated values (field absent in truth): **${summary.hallucinations}**`,
    '',
    '| Field | Accuracy |',
    '|---|---|',
    ...FIELD_NAMES.map((f) => `| ${FIELD_LABELS[f]} | ${pct(summary.fieldAccuracy[f])} |`),
    '',
  ].join('\n');

  fs.writeFileSync(path.join(reportDir, `eval-${stamp}.json`), JSON.stringify({ summary, perDoc }, null, 2));
  fs.writeFileSync(path.join(reportDir, `eval-${stamp}.md`), md);
  console.log('\n' + md);
  console.log(`Reports written to tests/evaluation/reports/eval-${stamp}.{json,md}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
