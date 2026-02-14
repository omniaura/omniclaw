# Smart Auto-Respond

By default, NanoClaw only responds when explicitly mentioned with the trigger word (e.g., `@Omni`). This prevents the bot from responding to every message in group chats.

However, you can configure groups to auto-respond based on message content without requiring explicit mentions.

## Configuration

Add these optional fields to your group config in `~/.claude/groups/{group-name}/config.json`:

```json
{
  "name": "My Group",
  "folder": "my-group",
  "trigger": "@Omni",
  "autoRespondToQuestions": true,
  "autoRespondKeywords": ["omni", "help", "claude"]
}
```

### `autoRespondToQuestions`

**Type:** `boolean` (default: `false`)

When `true`, the bot will automatically respond to any message ending with `?` (question mark).

**Example:**
```text
User: "What's the weather like today?"
Bot: *responds automatically without @mention*
```

### `autoRespondKeywords`

**Type:** `string[]` (default: `undefined`)

Array of keywords that trigger an automatic response when mentioned in a message (case-insensitive).

**Example:**
```json
"autoRespondKeywords": ["omni", "help", "claude"]
```

With this config:
```text
User: "Can someone help me with this code?"
Bot: *responds automatically because "help" keyword was detected*

User: "Hey Omni, what do you think?"
Bot: *responds automatically because "omni" keyword was detected*
```

## Use Cases

### Q&A Channel
Enable `autoRespondToQuestions` in a support or Q&A channel:
```json
{
  "name": "Support Channel",
  "autoRespondToQuestions": true
}
```

### Keyword Monitoring
Set keywords to monitor discussions about specific topics:
```json
{
  "name": "Dev Chat",
  "autoRespondKeywords": ["deployment", "production", "bug", "error"]
}
```

### Natural Conversations
Combine both for more natural chat flow:
```json
{
  "name": "Team Chat",
  "autoRespondToQuestions": true,
  "autoRespondKeywords": ["omni", "assistant", "help"]
}
```

## Important Notes

### Bot Messages
Bot-to-bot messages are still filtered to prevent infinite loops. Other bots must explicitly @mention your bot to trigger a response, regardless of auto-respond settings.

### DMs
Direct messages (DMs) always trigger responses, regardless of these settings.

### Cost Considerations
Auto-responding increases API usage. Every triggered message consumes Claude API credits. Use sparingly in high-traffic channels.

**Recommendation:** Enable auto-respond only in:
- Low-traffic channels (< 50 messages/day)
- Dedicated Q&A/support channels
- Private group chats

Avoid in:
- High-traffic general channels
- Public Discord servers with 100+ members
- Channels with frequent off-topic discussion

## Examples

### Conservative (Recommended)
```json
{
  "autoRespondToQuestions": true
}
```
Only responds to explicit questions. Minimizes false positives.

### Moderate
```json
{
  "autoRespondToQuestions": true,
  "autoRespondKeywords": ["omni"]
}
```
Responds to questions + when your bot's name is mentioned casually.

### Aggressive (High Cost)
```json
{
  "autoRespondToQuestions": true,
  "autoRespondKeywords": ["help", "question", "how", "why", "what", "when"]
}
```
Responds to most conversational patterns. High API usage.

## Disabling

To disable auto-respond, either:
1. Remove the fields from config
2. Set `autoRespondToQuestions: false` and remove `autoRespondKeywords`
3. Keep `requiresTrigger: true` (default behavior)
