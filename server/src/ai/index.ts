import type { AppConfig } from '../config.js';
import { ClaudeExtractor } from './claudeExtractor.js';
import { DemoExtractor } from './demoExtractor.js';
import type { Extractor } from './types.js';

export function createExtractor(config: AppConfig): Extractor {
  if (config.ai.mode === 'claude') {
    return new ClaudeExtractor({
      apiKey: config.ai.apiKey,
      model: config.ai.model,
      timeoutMs: config.ai.timeoutMs,
      maxInputChars: config.ai.maxInputChars,
    });
  }
  return new DemoExtractor(config.env === 'test' ? 0 : 900);
}

export * from './types.js';
