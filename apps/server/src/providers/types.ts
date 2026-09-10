export interface ModelConfig { baseUrl: string; model: string; apiKey: string }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export type ModelEvent = { type: 'delta'; text: string } | { type: 'complete'; calls: ToolCall[]; usage?: Usage };
export interface Provider {
  stream(messages: ModelMessage[], tools: ToolDefinition[], signal: AbortSignal): AsyncIterable<ModelEvent>;
}
export class ProviderError extends Error {}
export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
