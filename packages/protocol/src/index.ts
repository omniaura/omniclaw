import * as S from '@effect/schema/Schema';
import { Either } from 'effect';

export const AgentRuntimeSchema = S.Literal('claude-agent-sdk', 'opencode');
export type AgentRuntime = S.Schema.Type<typeof AgentRuntimeSchema>;

export const ChannelInfoSchema = S.Struct({
  id: S.String,
  jid: S.String,
  name: S.String,
});
export type ChannelInfo = S.Schema.Type<typeof ChannelInfoSchema>;

export const ChannelInfoArraySchema = S.Array(ChannelInfoSchema);

export const ContainerInputSchema = S.Struct({
  prompt: S.String,
  groupFolder: S.String,
  chatJid: S.String,
  isMain: S.Boolean,
  sessionId: S.optional(S.String),
  resumeAt: S.optional(S.String),
  runtimeFolder: S.optional(S.String),
  isScheduledTask: S.optional(S.Boolean),
  discordGuildId: S.optional(S.String),
  serverFolder: S.optional(S.String),
  secrets: S.optional(S.Record({ key: S.String, value: S.String })),
  agentRuntime: S.optional(AgentRuntimeSchema),
  channels: S.optional(S.Array(ChannelInfoSchema)),
  agentName: S.optional(S.String),
  discordBotId: S.optional(S.String),
  agentTrigger: S.optional(S.String),
  agentContextFolder: S.optional(S.String),
  channelFolder: S.optional(S.String),
  categoryFolder: S.optional(S.String),
});
export type ContainerInput = S.Schema.Type<typeof ContainerInputSchema>;

export const ContainerOutputSchema = S.Struct({
  status: S.Literal('success', 'error'),
  result: S.Union(S.String, S.Null),
  newSessionId: S.optional(S.String),
  resumeAt: S.optional(S.String),
  error: S.optional(S.String),
  intermediate: S.optional(S.Boolean),
  chatJid: S.optional(S.String),
});
export type ContainerOutput = S.Schema.Type<typeof ContainerOutputSchema>;

const decodeContainerInputSyncInternal =
  S.decodeUnknownSync(ContainerInputSchema);

export function decodeContainerInputSync(value: unknown): ContainerInput {
  return decodeContainerInputSyncInternal(value);
}

const decodeAgentRuntimeEither = S.decodeUnknownEither(AgentRuntimeSchema);
const decodeChannelInfoArrayEither = S.decodeUnknownEither(
  ChannelInfoArraySchema,
);

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return Either.isRight(decodeAgentRuntimeEither(value));
}

export function decodeChannelInfoArrayOrNull(
  value: unknown,
): ReadonlyArray<ChannelInfo> | null {
  const result = decodeChannelInfoArrayEither(value);
  return Either.isRight(result) ? result.right : null;
}
