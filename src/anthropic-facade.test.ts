import { describe, expect, it } from 'vitest';

import {
  anthropicMessagesToOpenAi,
  openAiToAnthropicMessage,
} from './anthropic-facade.js';

describe('anthropic-facade translation', () => {
  it('maps anthropic messages with tool blocks to OpenAI format', () => {
    const messages = anthropicMessagesToOpenAi({
      system: 'be precise',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will call a tool' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'calc',
              input: { a: 1 },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '2' }],
        },
      ],
    });

    expect(messages[0]).toMatchObject({ role: 'system', content: 'be precise' });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1' }],
    });
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  it('maps OpenAI tool call response to anthropic tool_use', () => {
    const mapped = openAiToAnthropicMessage({
      model: 'llama3.2',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                function: { name: 'search', arguments: '{"q":"foo"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });

    expect(mapped.model).toBe('llama3.2');
    expect(mapped.stop_reason).toBe('tool_use');
    expect(mapped.content[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_abc',
      name: 'search',
    });
    expect(mapped.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });
});
