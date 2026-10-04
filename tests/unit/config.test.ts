import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config.js';

describe('production configuration guards', () => {
  it('refuses demo sign-in in production unless PUBLIC_DEMO is explicitly set', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/AUTH_MODE=dev is not permitted/);
    expect(loadConfig({ NODE_ENV: 'production', PUBLIC_DEMO: 'true' }).publicDemo).toBe(true);
  });

  it('PUBLIC_DEMO never uses the Claude API, even when a key is present', () => {
    const c = loadConfig({ NODE_ENV: 'production', PUBLIC_DEMO: 'true', ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(c.ai.mode).toBe('demo');
    expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_DEMO: 'true', AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test' })).toThrow(
      /PUBLIC_DEMO/,
    );
  });

  it('forces HTTPS headers in production by default, but allows plain-HTTP hosting to opt out', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).forceHttps).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', PUBLIC_DEMO: 'true' }).forceHttps).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production', PUBLIC_DEMO: 'true', FORCE_HTTPS: 'false' }).forceHttps).toBe(false);
  });

  it('reads the port Elastic Beanstalk provides', () => {
    expect(loadConfig({ PORT: '8080' }).port).toBe(8080);
  });
});
