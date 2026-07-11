# VoiceFlow AI — Voice Service (Phase 2)

The Twilio + Gemini voice pipeline: answers real phone calls, has a natural conversation,
and books appointments directly into the same Postgres database your backend and mobile
app already use.

## How it works

Instead of raw audio streaming (which needs a WebSocket bridge to a separate STT/TTS
provider like Deepgram or ElevenLabs — a much bigger lift), this uses **Twilio's built-in
speech recognition and neural voices**:

1. Call comes in → Twilio hits `POST /voice/incoming`
2. We look up the business by the number that was called, fetch its AI Settings
   (greeting, services, FAQ, booking rules), and respond with TwiML: Twilio speaks the
   greeting and starts listening (`<Gather input="speech">`)
3. Twilio transcribes what the caller says and hits `POST /voice/gather` with the text
4. We send the conversation so far to Gemini, which decides: keep talking, book the
   appointment, or end the call — and replies with what to say next
5. We speak Gemini's response via Twilio (`<Say>`) and either keep gathering, hang up, or
   (if booking info is complete) create the real appointment first
6. When the call actually ends — however it ends — Twilio hits `POST /voice/status`,
   which is where we write the final `calls` table row (duration, transcript, outcome)

Twilio's speech recognition = the "STT". Gemini = the "LLM" brain. Twilio's `<Say>` = the
"TTS". No audio files, no WebSockets, no separate voice-AI vendor needed for the MVP.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `DATABASE_URL` — same database your main backend uses
- `GEMINI_API_KEY` — get one at https://aistudio.google.com/apikey (free tier)
- `PUBLIC_BASE_URL` — see the ngrok step below

Start it:
```bash
npm run dev
# -> http://localhost:4001/health should return {"status":"ok"}
```

## Making it reachable from a real phone call

Twilio needs to send webhooks to a public HTTPS URL — `localhost` doesn't work. For local
testing, use ngrok:

```bash
# in a separate terminal
ngrok http 4001
```

Copy the `https://....ngrok-free.app` URL it gives you, and:
1. Put it in `.env` as `PUBLIC_BASE_URL` (no trailing slash), then restart `npm run dev`
2. In the Twilio Console → Phone Numbers → your number → **Voice Configuration**:
   - "A call comes in" → Webhook → `https://your-ngrok-url.ngrok-free.app/voice/incoming` → HTTP POST
   - "Call status changes" (further down, under status callback settings) →
     `https://your-ngrok-url.ngrok-free.app/voice/status` → HTTP POST

**Important:** the business's `phone_number` field (set via the mobile app's business
profile or AI Settings) must exactly match your Twilio number's format, e.g. `+491701234567`.
The voice service looks up which business owns a call by matching Twilio's `To` field
against that column.

ngrok URLs change every time you restart it on the free tier — you'll need to re-paste the
new URL into both `.env` and the Twilio Console each time, until you deploy this somewhere
with a stable domain (Render/Railway/Fly.io all work fine for a small Express app like this).

## Testing without waiting for real customers

Call your Twilio number yourself. Try:
- "Hi, I'd like to book an appointment" → should ask for service, date, time, name
- Ask something from your FAQ list → should answer directly, no booking flow triggered
- Give a time that's already booked → should ask you to pick a different time

Then check:
- The `calls` table (or the mobile app's Home screen stats) for the logged call
- The `appointments` table (or Appointments tab) if you completed a booking

## Known simplifications (fine for MVP, worth revisiting later)

- **Timezone handling**: dates/times from Gemini are parsed using this server's local
  timezone, not each business's configured `timezone`. Fine if you and your businesses are
  in the same timezone; swap in a library like `luxon` if you expand beyond that.
- **In-memory conversation state**: call state lives in a JS `Map`, not the database. Fine
  for one running instance; would need Redis (or similar) if this ever runs on multiple
  server instances at once.
- **No Twilio signature validation by default**: `VALIDATE_TWILIO_SIGNATURE` in `.env` is
  off for easier local testing. Turn it on (and implement `twilio.validateRequest` in
  `src/index.ts`) before exposing this permanently in production, so random people can't
  POST fake call data to your webhooks.
- **English prompts by default**: the system prompt and Twilio's `<Say>`/`<Gather>`
  language are set to `en-US` via `GATHER_LANGUAGE` in `src/routes/voice.ts` — adjust it
  there if you want a different default, or make it per-business later.
- **No call recording**: `calls.recording_url` exists in the schema but this pipeline never
  sets it — Twilio's `record: true` / Recording API isn't wired up, so it stays null for
  every AI-handled call.
- **No upselling**: the system prompt only handles booking + FAQ; it never proposes
  additional services.
