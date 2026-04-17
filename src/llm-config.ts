import { readEnvFile } from './env.js';
import {
  LLM_API_KEY_ENV_VAR,
  LLM_AUTH_MODE,
  LLM_BASE_URL,
  LLM_HEADERS_JSON,
  LLM_MODEL,
  LLM_PROVIDER,
  LLM_TIMEOUT_MS,
} from './config.js';
import { RegisteredGroup, LlmAuthMode, LlmConfig, LlmProvider } from './types.js';

export interface ResolvedLlmConfig extends LlmConfig {
  source: 'group' | 'global';
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function parseProvider(value: string | undefined): LlmProvider {
  if (value === 'openai_compat') return 'openai_compat';
  return 'anthropic';
}

function parseAuthMode(value: string | undefined, provider: LlmProvider): LlmAuthMode {
  if (value === 'api_key' || value === 'none' || value === 'onecli') return value;
  if (provider === 'anthropic') return 'onecli';
  return 'none';
}

export function getGlobalLlmConfig(): LlmConfig {
  const provider = parseProvider(LLM_PROVIDER);
  const authMode = parseAuthMode(LLM_AUTH_MODE, provider);
  return {
    provider,
    baseUrl: LLM_BASE_URL || undefined,
    model: LLM_MODEL || undefined,
    authMode,
    apiKeyEnvVar: LLM_API_KEY_ENV_VAR || undefined,
    headers: parseHeaders(LLM_HEADERS_JSON),
    timeoutMs: LLM_TIMEOUT_MS || undefined,
  };
}

export function resolveLlmConfig(group: RegisteredGroup): ResolvedLlmConfig {
  const globalCfg = getGlobalLlmConfig();
  const groupCfg = group.containerConfig?.llm;

  if (!groupCfg) {
    return {
      ...globalCfg,
      source: 'global',
    };
  }

  const provider = groupCfg.provider || globalCfg.provider;
  const authMode =
    groupCfg.authMode || globalCfg.authMode || parseAuthMode(undefined, provider);
  return {
    provider,
    baseUrl: groupCfg.baseUrl ?? globalCfg.baseUrl,
    model: groupCfg.model ?? globalCfg.model,
    authMode,
    apiKeyEnvVar: groupCfg.apiKeyEnvVar ?? globalCfg.apiKeyEnvVar,
    headers: groupCfg.headers ?? globalCfg.headers,
    timeoutMs: groupCfg.timeoutMs ?? globalCfg.timeoutMs,
    source: 'group',
  };
}

export function validateLlmConfig(config: LlmConfig): string[] {
  const errors: string[] = [];

  if (config.provider === 'openai_compat') {
    if (!config.baseUrl) {
      errors.push('openai_compat provider requires baseUrl');
    }
    if (!config.model) {
      errors.push('openai_compat provider requires model');
    }
    if (config.authMode === 'onecli') {
      errors.push('openai_compat provider does not support authMode=onecli');
    }
  }

  if (config.authMode === 'api_key' && !config.apiKeyEnvVar) {
    errors.push('authMode=api_key requires apiKeyEnvVar');
  }

  if (config.timeoutMs != null && config.timeoutMs <= 0) {
    errors.push('timeoutMs must be greater than 0');
  }

  return errors;
}

export function resolveApiKey(envVar: string | undefined): string | undefined {
  if (!envVar) return undefined;
  if (process.env[envVar]) return process.env[envVar];
  const envFromFile = readEnvFile([envVar]);
  return envFromFile[envVar];
}
