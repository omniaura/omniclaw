import type { ContainerInput, ContainerOutput } from '@omniclaw/protocol';

export function getOriginChatJid(containerInput: ContainerInput): string {
  return containerInput.originChatJid || containerInput.chatJid;
}

export function withOutputChatJid(
  output: ContainerOutput,
  chatJid: string,
): ContainerOutput {
  return chatJid ? { ...output, chatJid } : output;
}
