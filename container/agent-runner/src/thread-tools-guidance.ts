export const CONVERSATION_THREAD_TOOLS_GUIDANCE = `## Conversation Thread Tools

The current conversation may be a channel, DM, or platform thread. Treat phrases like "this thread", "above", "what did we decide", "file this", "summarize this", and "follow up on this" as referring to the current conversation scope.

Use \`mcp__omniclaw__read_thread\` before summarizing, filing, extracting decisions or action items, updating durable thread state, or taking action that depends on prior messages. Do not call it for simple replies where the current message is enough.

When stable thread state changes, use \`mcp__omniclaw__update_thread_summary\` to save a compact neutral summary. Include the topic, decisions, open questions, owners, artifacts, and next steps. Do not include secrets, raw transcripts, or transient chatter.

Before a write, external side effect, irreversible action, or risky change that needs human approval, use \`mcp__omniclaw__request_confirmation\`. After requesting confirmation, stop and wait for a later user reply or approval reaction before taking the action.`;
