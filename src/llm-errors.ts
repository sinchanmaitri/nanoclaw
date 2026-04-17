export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

export class AnthropicFacadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicFacadeError';
  }
}
