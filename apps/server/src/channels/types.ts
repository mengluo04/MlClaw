import type { ChannelKind } from '@mlclaw/shared';

export class ChannelError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export class DeliveryError extends Error {
  constructor(public outcome: 'failed' | 'unknown', message = '平台未确认投递结果') { super(message); }
}
export interface ChannelAccount {
  id: string; userId: string; kind: ChannelKind; remoteId: string; secret: string; baseUrl: string;
  enabled: boolean; cursor: string; pairedSender: string | null;
}
export interface InboundMessage {
  eventId: string; senderId: string; text: string; replyContext: string;
}
export interface OutboundMessage extends InboundMessage { id: string; part: number; proactive?: boolean }
export interface ChannelSink {
  receive(message: InboundMessage): void;
  cursor(value: string): void;
  state(value: 'connecting' | 'connected' | 'error' | 'expired', message?: string): void;
}
export interface ChannelTransport {
  run(signal: AbortSignal): Promise<void>;
  send(message: OutboundMessage, signal: AbortSignal): Promise<void>;
}
export type TransportFactory = (account: ChannelAccount, sink: ChannelSink) => ChannelTransport;

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelError('平台响应格式无效', 502);
  return value as Record<string, unknown>;
}
export function boundedString(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new ChannelError('平台字段格式无效', 502);
  return value;
}
