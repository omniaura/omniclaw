# Known Issues - NanoClaw

This file tracks known issues and bugs in the NanoClaw fork.

---

## Discord @AllAgents Rate Limit Error (Opcode 8)

**Status:** 🔴 Active Issue
**Severity:** Medium
**Date Reported:** 2026-02-14

### Issue

The `@AllAgents` feature in Discord is hitting rate limits when trying to fetch guild members.

### Error

```json
{
  "type": "GatewayRateLimitError",
  "message": "Request with opcode 8 was rate limited. Retry after 29.457 seconds.",
  "data": {
    "retry_after": 29.457,
    "opcode": 8,
    "meta": {
      "nonce": "1472155300759867397",
      "guild_id": "753336633083953213"
    }
  },
  "payload": {
    "guild_id": "753336633083953213",
    "query": "",
    "nonce": "1472155300759867397",
    "limit": 0
  }
}
```

**Log message:** `Failed to fetch bot members for @AllAgents`

### Context

- **Opcode 8** = Request Guild Members (Discord Gateway opcode)
- **Rate limit:** ~29 seconds retry window
- **Guild ID:** 753336633083953213
- **Location:** `src/channels/discord.ts`

### Root Cause

The @AllAgents feature is calling Discord's Request Guild Members opcode (8) without proper rate limit handling. This opcode has strict rate limits imposed by Discord.

### Recommendations

1. **Cache guild members** - Only fetch once per session or when needed (5-10 minute cache TTL)
2. **Add rate limit backoff** - Respect `retry_after` from Discord errors
3. **Use privileged gateway intents** - Ensure bot has proper guild member intents (fixed in #19)
4. **Alternative approach** - Consider using REST API `/guilds/{guild.id}/members` with pagination instead of gateway opcode 8

### Related

- Discord Gateway Opcode 8 docs: https://discord.com/developers/docs/topics/gateway#request-guild-members
- Rate limits: https://discord.com/developers/docs/topics/rate-limits
- Related PR #19: Stability quick wins (includes gateway intent fixes)

### Suggested Fix

```typescript
// Add caching and rate limit handling
const guildMemberCache = new Map<string, { members: any[], timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchGuildMembers(guildId: string) {
  const cached = guildMemberCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.members;
  }

  try {
    const members = await guild.members.fetch();
    guildMemberCache.set(guildId, { members, timestamp: Date.now() });
    return members;
  } catch (error) {
    if (error.data?.retry_after) {
      // Wait and retry
      await new Promise(resolve => setTimeout(resolve, error.data.retry_after * 1000));
      return fetchGuildMembers(guildId);
    }
    throw error;
  }
}
```

### Priority

Medium - Feature is non-functional due to rate limiting but has workaround (don't use @AllAgents)

---

*Last Updated: 2026-02-14*
