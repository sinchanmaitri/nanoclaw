import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

import { ANTHROPIC_FACADE_PORT } from './config.js';
import { AnthropicFacadeError } from './llm-errors.js';
import { logger } from './logger.js';

export interface OpenAiCompatRoute {
  token: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAiCompletionResponse {
  id?: string;
  model?: string;
  choices: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeSystemText(system: unknown): string | undefined {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return undefined;
  return system
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim();
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function anthropicMessagesToOpenAi(body: any): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = [];

  const system = normalizeSystemText(body.system);
  if (system) {
    out.push({ role: 'system', content: system });
  }

  if (!Array.isArray(body.messages)) return out;

  for (const msg of body.messages) {
    const role = msg?.role === 'assistant' ? 'assistant' : 'user';
    const content = msg?.content;
    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      out.push({ role, content: stringifyUnknown(content) });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: OpenAiChatMessage['tool_calls'] = [];
    const toolResults: Array<{ id: string; content: unknown }> = [];

    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block?.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${randomUUID().slice(0, 12)}`,
          type: 'function',
          function: {
            name: block.name || 'tool',
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block?.type === 'tool_result') {
        toolResults.push({ id: block.tool_use_id || '', content: block.content });
      }
    }

    const text = textParts.join('\n').trim();
    if (toolCalls.length > 0) {
      out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
    } else {
      out.push({ role, content: text || '' });
    }

    for (const toolResult of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: toolResult.id,
        content: stringifyUnknown(toolResult.content),
      });
    }
  }

  return out;
}

function mapTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool?.name,
      description: tool?.description,
      parameters: tool?.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function mapToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === 'auto' || toolChoice === 'any') return 'auto';
  if (toolChoice === 'none') return 'none';
  if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    (toolChoice as any).type === 'tool'
  ) {
    return {
      type: 'function',
      function: { name: (toolChoice as any).name },
    };
  }
  return undefined;
}

function parseJsonSafe(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function openAiToAnthropicMessage(
  response: OpenAiCompletionResponse,
): {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
} {
  const choice = response.choices?.[0] || {};
  const message = choice.message || {};
  const contentBlocks: AnthropicContentBlock[] = [];

  if (message.content && message.content.trim()) {
    contentBlocks.push({ type: 'text', text: message.content });
  }

  for (const call of message.tool_calls || []) {
    contentBlocks.push({
      type: 'tool_use',
      id: call.id || `toolu_${randomUUID().slice(0, 16)}`,
      name: call.function?.name || 'tool',
      input: parseJsonSafe(call.function?.arguments),
    });
  }

  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
  if ((message.tool_calls || []).length > 0) {
    stopReason = 'tool_use';
  } else if (choice.finish_reason === 'length') {
    stopReason = 'max_tokens';
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: response.model || 'openai_compat',
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    },
  };
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeAnthropicStream(
  res: ServerResponse,
  message: ReturnType<typeof openAiToAnthropicMessage>,
): void {
  writeSse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: message.usage,
    },
  });

  message.content.forEach((block, idx) => {
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: idx,
      content_block: block,
    });
    if (block.type === 'text') {
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'text_delta', text: block.text },
      });
    }
    writeSse(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: idx,
    });
  });

  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
    },
    usage: message.usage,
  });
  writeSse(res, 'message_stop', { type: 'message_stop' });
}

class AnthropicFacade {
  private routes = new Map<string, OpenAiCompatRoute>();
  private started = false;

  registerRoute(route: OpenAiCompatRoute): void {
    this.routes.set(route.token, route);
    if (!this.started) this.start();
  }

  private async callOpenAiCompat(
    route: OpenAiCompatRoute,
    payload: Record<string, unknown>,
  ): Promise<OpenAiCompletionResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(route.headers || {}),
    };
    if (route.apiKey) {
      headers.authorization = `Bearer ${route.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      route.timeoutMs || 30_000,
    );
    try {
      const response = await fetch(
        `${route.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new AnthropicFacadeError(
          `OpenAI-compatible upstream failed (${response.status}): ${text.slice(0, 400)}`,
        );
      }
      return (await response.json()) as OpenAiCompletionResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getRouteFromRequest(req: IncomingMessage): OpenAiCompatRoute | null {
    const xApiKey = req.headers['x-api-key'];
    const auth = req.headers.authorization;

    let token: string | undefined;
    if (typeof xApiKey === 'string' && xApiKey.trim()) {
      token = xApiKey.trim();
    } else if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      token = auth.slice('Bearer '.length).trim();
    }

    if (!token) return null;
    return this.routes.get(token) || null;
  }

  private start(): void {
    this.started = true;
    createServer(async (req, res) => {
      try {
        if (!req.url) {
          res.writeHead(404).end();
          return;
        }

        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, routes: this.routes.size }));
          return;
        }

        if (req.method !== 'POST' || req.url !== '/v1/messages') {
          res.writeHead(404).end();
          return;
        }

        const route = this.getRouteFromRequest(req);
        if (!route) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'authentication_error' } }));
          return;
        }

        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const stream = body.stream === true;

        const payload: Record<string, unknown> = {
          model: route.model,
          messages: anthropicMessagesToOpenAi(body),
          tools: mapTools(body.tools),
          tool_choice: mapToolChoice(body.tool_choice),
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          stream: false,
        };

        const completion = await this.callOpenAiCompat(route, payload);
        const anthropicMessage = openAiToAnthropicMessage(completion);

        if (stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          writeAnthropicStream(res, anthropicMessage);
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthropicMessage));
      } catch (err) {
        logger.error({ err }, 'Anthropic facade request failed');
        res.writeHead(500, { 'content-type': 'application/json' });
        const message = err instanceof Error ? err.message : String(err);
        res.end(
          JSON.stringify({
            error: {
              type: 'api_error',
              message,
            },
          }),
        );
      }
    }).listen(ANTHROPIC_FACADE_PORT, '0.0.0.0', () => {
      logger.info(
        { port: ANTHROPIC_FACADE_PORT },
        'Anthropic facade started for openai_compat routes',
      );
    });
  }
}

const facade = new AnthropicFacade();

export function registerOpenAiCompatRoute(route: OpenAiCompatRoute): void {
  facade.registerRoute(route);
}

export {
  anthropicMessagesToOpenAi,
  mapTools,
  mapToolChoice,
  openAiToAnthropicMessage,
};
