import type { NewMessage } from './types.js';

type AttentiveMessage = Pick<
  NewMessage,
  'sender' | 'sender_name' | 'sender_platform'
>;

export function isAttentiveEligibleMessage(message: AttentiveMessage): boolean {
  if (message.sender.startsWith('agent:')) return false;
  if (message.sender === 'system') return false;
  if (message.sender_platform === 'system') return false;
  if (message.sender_platform === 'ipc') return false;
  if (message.sender_name === 'System') return false;
  return true;
}

export function hasAttentiveEligibleMessage(
  messages: readonly AttentiveMessage[],
): boolean {
  return messages.some(isAttentiveEligibleMessage);
}
