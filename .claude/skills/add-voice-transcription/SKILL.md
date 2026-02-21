---
name: add-voice-transcription
description: Add voice message transcription to OmniClaw using OpenAI's Whisper API. Automatically transcribes WhatsApp voice notes so the agent can read and respond to them.
---

# Add Voice Transcription

This skill adds automatic voice message transcription to OmniClaw's WhatsApp channel using OpenAI's Whisper API. When a voice note arrives, it is downloaded, transcribed, and delivered to the agent as `[Voice: <transcript>]`.

## Phase 1: Pre-flight

### Check if already applied

Read `.omniclaw/state.yaml`. If `voice-transcription` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

1. **Do they have an OpenAI API key?** If yes, collect it now. If no, they'll need to create one at https://platform.openai.com/api-keys.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.omniclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-voice-transcription
```

This deterministically:
- Adds `src/transcription.ts` (voice transcription module using OpenAI Whisper)
- Three-way merges voice handling into `src/channels/whatsapp.ts` (isVoiceMessage check, transcribeAudioMessage call)
- Three-way merges transcription tests into `src/channels/whatsapp.test.ts` (mock + 3 test cases)
- Installs the `openai` npm dependency
- Updates `.env.example` with `OPENAI_API_KEY`
- Records the application in `.omniclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/whatsapp.ts.intent.md` — what changed and invariants for whatsapp.ts
- `modify/src/channels/whatsapp.test.ts.intent.md` — what changed for whatsapp.test.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the 3 new voice transcription tests) and build must be clean before proceeding.

## Phase 3: Configure

### Get OpenAI API key (if needed)

If the user doesn't have an API key:

> I need you to create an OpenAI API key:
>
> 1. Go to https://platform.openai.com/api-keys
> 2. Click "Create new secret key"
> 3. Give it a name (e.g., "OmniClaw Transcription")
> 4. Copy the key (starts with `sk-`)
>
> Cost: ~$0.006 per minute of audio (~$0.003 per typical 30-second voice note)

Wait for the user to provide the key.

### Add to environment

<<<<<<< HEAD
## Implementation

### Step 1: Add OpenAI Dependency

Read `package.json` and add the `openai` package to dependencies:

```json
"dependencies": {
  ...existing dependencies...
  "openai": "^4.77.0"
}
```

Then install it. **IMPORTANT:** The OpenAI SDK requires Zod v3 as an optional peer dependency, but OmniClaw uses Zod v4. This conflict is guaranteed, so always use `--legacy-peer-deps`:
=======
Add to `.env`:
>>>>>>> a407216 (feat: add voice transcription as nanorepo skill (#326))

```bash
OPENAI_API_KEY=<their-key>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

<<<<<<< HEAD
> I've created `.transcription.config.json` in the project root. You'll need to add your OpenAI API key to it manually:
>
> 1. Open `.transcription.config.json`
> 2. Replace the empty `"apiKey": ""` with your key: `"apiKey": "sk-proj-..."`
> 3. Save the file
>
> Let me know when you've added it.

Wait for user confirmation.

### Step 3: Create Transcription Module

Create `src/transcription.ts`:

```typescript
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration interface
interface TranscriptionConfig {
  provider: string;
  openai?: {
    apiKey: string;
    model: string;
  };
  enabled: boolean;
  fallbackMessage: string;
}

// Load configuration
function loadConfig(): TranscriptionConfig {
  const configPath = path.join(__dirname, '../.transcription.config.json');
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } catch (err) {
    console.error('Failed to load transcription config:', err);
    return {
      provider: 'openai',
      enabled: false,
      fallbackMessage: '[Voice Message - transcription unavailable]'
    };
  }
}

// Transcribe audio using OpenAI Whisper API
async function transcribeWithOpenAI(audioBuffer: Buffer, config: TranscriptionConfig): Promise<string | null> {
  if (!config.openai?.apiKey || config.openai.apiKey === '') {
    console.warn('OpenAI API key not configured');
    return null;
  }

  try {
    // Dynamic import of openai
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({
      apiKey: config.openai.apiKey
    });

    // Use OpenAI's toFile helper to create a proper file upload
    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg'
    });

    // Call Whisper API
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: config.openai.model || 'whisper-1',
      response_format: 'text'
    });

    // Type assertion needed: OpenAI SDK types response_format='text' as Transcription object,
    // but it actually returns a plain string when response_format is 'text'
    return transcription as unknown as string;
  } catch (err) {
    console.error('OpenAI transcription failed:', err);
    return null;
  }
}

// Main transcription function
export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket
): Promise<string | null> {
  const config = loadConfig();

  // Check if transcription is enabled
  if (!config.enabled) {
    console.log('Transcription disabled in config');
    return config.fallbackMessage;
  }

  try {
    // Download the audio message
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage
      }
    ) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    // Transcribe based on provider
    let transcript: string | null = null;

    switch (config.provider) {
      case 'openai':
        transcript = await transcribeWithOpenAI(buffer, config);
        break;
      default:
        console.error(`Unknown transcription provider: ${config.provider}`);
        return config.fallbackMessage;
    }

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return config.fallbackMessage;
  }
}

// Helper to check if a message is a voice note
export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
```

### Step 4: Update Database to Handle Transcribed Content

Read `src/db.ts` and find the `storeMessage` function. Update its signature and implementation to accept transcribed content:

Change the function signature from:
```typescript
export function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean, pushName?: string): void
```

To:
```typescript
export function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean, pushName?: string, transcribedContent?: string): void
```

Update the content extraction to use transcribed content if provided:

```typescript
const content = transcribedContent ||
  msg.message?.conversation ||
  msg.message?.extendedTextMessage?.text ||
  msg.message?.imageMessage?.caption ||
  msg.message?.videoMessage?.caption ||
  (msg.message?.audioMessage?.ptt ? '[Voice Message]' : '') ||
  '';
```

### Step 5: Integrate Transcription into Message Handler

**Note:** Voice messages are transcribed for all messages in registered groups, regardless of the trigger word. This is because:
1. Voice notes can't easily include a trigger word
2. Users expect voice notes to work the same as text messages
3. The transcribed content is stored in the database for context, even if it doesn't trigger the agent

Read `src/index.ts` and find the `sock.ev.on('messages.upsert', ...)` event handler.

Change the callback from synchronous to async:

```typescript
sock.ev.on('messages.upsert', async ({ messages }) => {
```

Inside the loop where messages are stored, add voice message detection and transcription:

```typescript
// Only store full message content for registered groups
if (registeredGroups[chatJid]) {
  // Check if this is a voice message
  if (msg.message.audioMessage?.ptt) {
    try {
      // Import transcription module
      const { transcribeAudioMessage } = await import('./transcription.js');
      const transcript = await transcribeAudioMessage(msg, sock);

      if (transcript) {
        // Store with transcribed content
        storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, `[Voice: ${transcript}]`);
        logger.info({ chatJid, length: transcript.length }, 'Transcribed voice message');
      } else {
        // Store with fallback message
        storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, '[Voice Message - transcription unavailable]');
      }
    } catch (err) {
      logger.error({ err }, 'Voice transcription error');
      storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, '[Voice Message - transcription failed]');
    }
  } else {
    // Regular message, store normally
    storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined);
  }
}
```

### Step 6: Fix Orphan Container Cleanup (CRITICAL)

**This step is essential.** When the OmniClaw service restarts (e.g., `launchctl kickstart -k`), the running container is detached but NOT killed. The new service instance spawns a fresh container, but the orphan keeps running and shares the same IPC mount directory. Both containers race to read IPC input files, causing the new container to randomly miss messages — making it appear like the agent doesn't respond.

The existing cleanup code in `ensureContainerSystemRunning()` in `src/index.ts` uses `container ls --format {{.Names}}` which **silently fails** on Apple Container (only `json` and `table` are valid format options). The catch block swallows the error, so orphans are never cleaned up.

Find the orphan cleanup block in `ensureContainerSystemRunning()` (the section starting with `// Kill and clean up orphaned OmniClaw containers from previous runs`) and replace it with:

```typescript
  // Kill and clean up orphaned OmniClaw containers from previous runs
  try {
    const listJson = execSync('container ls -a --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers = JSON.parse(listJson) as Array<{ configuration: { id: string }; status: string }>;
    const omniclawContainers = containers.filter(
      (c) => c.configuration.id.startsWith('omniclaw-'),
    );
    const running = omniclawContainers
      .filter((c) => c.status === 'running')
      .map((c) => c.configuration.id);
    if (running.length > 0) {
      execSync(`container stop ${running.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: running.length }, 'Stopped orphaned containers');
    }
    const allNames = omniclawContainers.map((c) => c.configuration.id);
    if (allNames.length > 0) {
      execSync(`container rm ${allNames.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: allNames.length }, 'Cleaned up stopped containers');
    }
  } catch {
    // No containers or cleanup not supported
  }
```

### Step 7: Build and Restart
=======
### Build and restart
>>>>>>> a407216 (feat: add voice transcription as nanorepo skill (#326))

```bash
npm run build
```

<<<<<<< HEAD
Before restarting the service, kill any orphaned containers manually to ensure a clean slate:

```bash
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c['configuration']['id'] for c in data if c['configuration']['id'].startswith('omniclaw-')]
if nc: print(' '.join(nc))
" | xargs -r container stop 2>/dev/null
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c['configuration']['id'] for c in data if c['configuration']['id'].startswith('omniclaw-')]
if nc: print(' '.join(nc))
" | xargs -r container rm 2>/dev/null
echo "Orphaned containers cleaned"
```

Now restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.omniclaw
```

Verify it started with exactly one (or zero, before first message) omniclaw container:

```bash
sleep 3 && launchctl list | grep omniclaw
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c for c in data if c['configuration']['id'].startswith('omniclaw-')]
print(f'{len(nc)} omniclaw container(s)')
for c in nc: print(f'  {c[\"configuration\"][\"id\"]} - {c[\"status\"]}')
"
```

### Step 8: Test Voice Transcription
=======
## Phase 4: Verify

### Test with a voice note
>>>>>>> a407216 (feat: add voice transcription as nanorepo skill (#326))

Tell the user:

> Send a voice note in any registered WhatsApp chat. The agent should receive it as `[Voice: <transcript>]` and respond to its content.

### Check logs if needed

```bash
<<<<<<< HEAD
tail -f logs/omniclaw.log | grep -i "voice\|transcri"
=======
tail -f logs/omniclaw.log | grep -i voice
>>>>>>> a407216 (feat: add voice transcription as nanorepo skill (#326))
```

Look for:
- `Transcribed voice message` — successful transcription with character count
- `OPENAI_API_KEY not set` — key missing from `.env`
- `OpenAI transcription failed` — API error (check key validity, billing)
- `Failed to download audio message` — media download issue

## Troubleshooting

<<<<<<< HEAD
### Agent doesn't respond to voice messages (or any messages after a voice note)

**Most likely cause: orphaned containers.** When the service restarts, the previous container keeps running and races to consume IPC messages. Check:

```bash
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c for c in data if c['configuration']['id'].startswith('omniclaw-')]
print(f'{len(nc)} omniclaw container(s):')
for c in nc: print(f'  {c[\"configuration\"][\"id\"]} - {c[\"status\"]}')
"
```

If you see more than one running container, kill the orphans:

```bash
# Stop all omniclaw containers, then restart the service
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
running = [c['configuration']['id'] for c in data if c['configuration']['id'].startswith('omniclaw-') and c['status'] == 'running']
if running: print(' '.join(running))
" | xargs -r container stop 2>/dev/null
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c['configuration']['id'] for c in data if c['configuration']['id'].startswith('omniclaw-')]
if nc: print(' '.join(nc))
" | xargs -r container rm 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.omniclaw
```

**Root cause:** The `ensureContainerSystemRunning()` function previously used `container ls --format {{.Names}}` which silently fails on Apple Container (only `json` and `table` formats are supported). Step 6 of this skill fixes this. If you haven't applied Step 6, the orphan problem will recur on every restart.

### "Transcription unavailable" or "Transcription failed"

Check logs for specific errors:
```bash
tail -100 logs/omniclaw.log | grep -i transcription
```
=======
### Voice notes show "[Voice Message - transcription unavailable]"

1. Check `OPENAI_API_KEY` is set in `.env` AND synced to `data/env/env`
2. Verify key works: `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | head -c 200`
3. Check OpenAI billing — Whisper requires a funded account
>>>>>>> a407216 (feat: add voice transcription as nanorepo skill (#326))

### Voice notes show "[Voice Message - transcription failed]"

Check logs for the specific error. Common causes:
- Network timeout — transient, will work on next message
- Invalid API key — regenerate at https://platform.openai.com/api-keys
- Rate limiting — wait and retry

### Agent doesn't respond to voice notes

<<<<<<< HEAD
### ES Module errors (`__dirname is not defined`)

The fix is already included in the implementation above using:
```typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

### Dependency conflicts (Zod versions)

The OpenAI SDK requires Zod v3, but OmniClaw uses Zod v4. This conflict is guaranteed — always use:
```bash
npm install --legacy-peer-deps
```

---

## Security Notes

- The `.transcription.config.json` file contains your API key and should NOT be committed to version control
- It's added to `.gitignore` by this skill
- Audio files are sent to OpenAI for transcription - review their data usage policy
- No audio files are stored locally after transcription
- Transcripts are stored in the SQLite database like regular text messages

---

## Cost Management

Monitor usage in your OpenAI dashboard: https://platform.openai.com/usage

Tips to control costs:
- Set spending limits in OpenAI account settings
- Disable transcription during development/testing with `"enabled": false`
- Typical usage: 100 voice notes/month (~3 minutes average) = ~$1.80

---

## Removing Voice Transcription

To remove the feature:

1. Remove from `package.json`:
   ```bash
   npm uninstall openai
   ```

2. Delete `src/transcription.ts`

3. Revert changes in `src/index.ts`:
   - Remove the voice message handling block
   - Change callback back to synchronous if desired

4. Revert changes in `src/db.ts`:
   - Remove the `transcribedContent` parameter from `storeMessage`

5. Delete `.transcription.config.json`

6. Rebuild:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.omniclaw
   ```

---

## Future Enhancements

Potential additions:
- **Local Whisper**: Use `whisper.cpp` or `faster-whisper` for offline transcription
- **Groq Integration**: Free tier with Whisper, very fast
- **Deepgram**: Alternative cloud provider
- **Language Detection**: Auto-detect and transcribe non-English voice notes
- **Cost Tracking**: Log transcription costs per message
- **Speaker Diarization**: Identify different speakers in voice notes
=======
Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups.
>>>>>>> a407216 (feat: add voice transcription as nanorepo skill (#326))
