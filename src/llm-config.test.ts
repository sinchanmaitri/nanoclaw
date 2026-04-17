import { describe, expect, it } from 'vitest';

import { resolveApiKey, resolveLlmConfig, validateLlmConfig } from './llm-config.js';
import type { RegisteredGroup } from './types.js';

describe('llm-config', () => {
  it('validates openai_compat requires baseUrl and model', () => {
    const errors = validateLlmConfig({
      provider: 'openai_compat',
      authMode: 'none',
    });
    expect(errors.join(' ')).toContain('baseUrl');
    expect(errors.join(' ')).toContain('model');
  });

  it('validates api_key requires apiKeyEnvVar', () => {
    const errors = validateLlmConfig({
      provider: 'anthropic',
      authMode: 'api_key',
    });
    expect(errors.join(' ')).toContain('apiKeyEnvVar');
  });

  it('resolves per-group config', () => {
    const group: RegisteredGroup = {
      name: 'g',
      folder: 'g',
      trigger: '@a',
      added_at: new Date().toISOString(),
      containerConfig: {
        llm: {
          provider: 'openai_compat',
          authMode: 'none',
          baseUrl: 'http://127.0.0.1:8000/v1',
          model: 'llama3.2',
        },
      },
    };
    const resolved = resolveLlmConfig(group);
    expect(resolved.provider).toBe('openai_compat');
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(resolved.model).toBe('llama3.2');
  });

  it('resolves API key from process env', () => {
    process.env.TEST_KEY = 'abc123';
    expect(resolveApiKey('TEST_KEY')).toBe('abc123');
    delete process.env.TEST_KEY;
  });
});
