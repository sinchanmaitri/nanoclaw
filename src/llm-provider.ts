import { createHash } from 'crypto';

import { OneCLI } from '@onecli-sh/sdk';

import { ANTHROPIC_FACADE_PORT, ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { registerOpenAiCompatRoute } from './anthropic-facade.js';
import { resolveApiKey, ResolvedLlmConfig, validateLlmConfig } from './llm-config.js';
import { LlmConfigError } from './llm-errors.js';
import { logger } from './logger.js';
import { RegisteredGroup, LlmProvider } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

export interface LlmHealthcheckResult {
  ok: boolean;
  details?: string;
}

export interface LlmProviderContext {
  group: RegisteredGroup;
  containerName: string;
  agentIdentifier?: string;
}

export interface LlmProviderAdapter {
  provider: LlmProvider;
  validateConfig(config: ResolvedLlmConfig): string[];
  prepareContainerArgs(
    args: string[],
    config: ResolvedLlmConfig,
    context: LlmProviderContext,
  ): Promise<void>;
  healthcheck(config: ResolvedLlmConfig): Promise<LlmHealthcheckResult>;
}

function addEnv(args: string[], key: string, value: string): void {
  args.push('-e', `${key}=${value}`);
}

class AnthropicProviderAdapter implements LlmProviderAdapter {
  provider: LlmProvider = 'anthropic';

  validateConfig(config: ResolvedLlmConfig): string[] {
    return validateLlmConfig(config);
  }

  async healthcheck(_config: ResolvedLlmConfig): Promise<LlmHealthcheckResult> {
    return { ok: true };
  }

  async prepareContainerArgs(
    args: string[],
    config: ResolvedLlmConfig,
    context: LlmProviderContext,
  ): Promise<void> {
    if (config.authMode === 'onecli') {
      const onecliApplied = await onecli.applyContainerConfig(args, {
        addHostMapping: false,
        agent: context.agentIdentifier,
      });
      if (!onecliApplied) {
        throw new LlmConfigError(
          'OneCLI gateway not reachable — anthropic provider cannot inject credentials',
        );
      }
      logger.info({ containerName: context.containerName }, 'OneCLI gateway config applied');
    }

    if (config.baseUrl) addEnv(args, 'ANTHROPIC_BASE_URL', config.baseUrl);
    if (config.model) addEnv(args, 'NANOCLAW_MODEL_OVERRIDE', config.model);
    if (config.timeoutMs) {
      addEnv(args, 'NANOCLAW_PROVIDER_TIMEOUT_MS', String(config.timeoutMs));
    }

    if (config.authMode === 'api_key') {
      const key = resolveApiKey(config.apiKeyEnvVar);
      if (!key) {
        throw new LlmConfigError(
          `Missing API key value for env var "${config.apiKeyEnvVar || ''}"`,
        );
      }
      addEnv(args, 'ANTHROPIC_API_KEY', key);
    }

    addEnv(args, 'NANOCLAW_LLM_PROVIDER', 'anthropic');
  }
}

class OpenAiCompatProviderAdapter implements LlmProviderAdapter {
  provider: LlmProvider = 'openai_compat';

  validateConfig(config: ResolvedLlmConfig): string[] {
    return validateLlmConfig(config);
  }

  async healthcheck(config: ResolvedLlmConfig): Promise<LlmHealthcheckResult> {
    if (!config.baseUrl) return { ok: false, details: 'Missing baseUrl' };

    const headers: Record<string, string> = { ...(config.headers || {}) };
    if (config.authMode === 'api_key') {
      const key = resolveApiKey(config.apiKeyEnvVar);
      if (!key) {
        return {
          ok: false,
          details: `Missing API key value for env var "${config.apiKeyEnvVar || ''}"`,
        };
      }
      headers.authorization = `Bearer ${key}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs || 5_000,
    );

    try {
      const response = await fetch(
        `${config.baseUrl.replace(/\/+$/, '')}/models`,
        { headers, signal: controller.signal },
      );
      if (!response.ok) {
        return {
          ok: false,
          details: `Upstream returned ${response.status} from /models`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        details: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async prepareContainerArgs(
    args: string[],
    config: ResolvedLlmConfig,
    context: LlmProviderContext,
  ): Promise<void> {
    const errors = this.validateConfig(config);
    if (errors.length > 0) {
      throw new LlmConfigError(errors.join('; '));
    }

    const check = await this.healthcheck(config);
    if (!check.ok) {
      throw new LlmConfigError(
        `openai_compat healthcheck failed: ${check.details || 'unknown error'}`,
      );
    }

    const apiKey =
      config.authMode === 'api_key'
        ? resolveApiKey(config.apiKeyEnvVar)
        : undefined;
    if (config.authMode === 'api_key' && !apiKey) {
      throw new LlmConfigError(
        `Missing API key value for env var "${config.apiKeyEnvVar || ''}"`,
      );
    }

    const token = createHash('sha256')
      .update(
        `${context.group.folder}|${config.baseUrl}|${config.model}|${config.authMode}`,
      )
      .digest('hex')
      .slice(0, 40);

    registerOpenAiCompatRoute({
      token,
      baseUrl: config.baseUrl!,
      model: config.model!,
      apiKey: apiKey || undefined,
      headers: config.headers,
      timeoutMs: config.timeoutMs,
    });

    addEnv(args, 'ANTHROPIC_BASE_URL', `http://host.docker.internal:${ANTHROPIC_FACADE_PORT}`);
    addEnv(args, 'ANTHROPIC_AUTH_TOKEN', token);
    addEnv(args, 'NANOCLAW_MODEL_OVERRIDE', config.model!);
    addEnv(args, 'NANOCLAW_LLM_PROVIDER', 'openai_compat');
  }
}

const anthropicAdapter = new AnthropicProviderAdapter();
const openAiCompatAdapter = new OpenAiCompatProviderAdapter();

export function getLlmProviderAdapter(provider: LlmProvider): LlmProviderAdapter {
  if (provider === 'openai_compat') return openAiCompatAdapter;
  return anthropicAdapter;
}
