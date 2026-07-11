import { AISettingsRow, Business } from './business';
import { ConversationTurn } from './conversationStore';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export interface GeminiTurnResult {
  say: string;
  action: 'continue' | 'book_appointment' | 'end_call';
  booking: {
    customerName?: string;
    serviceName?: string;
    date?: string; // YYYY-MM-DD
    time?: string; // HH:MM (24h)
  } | null;
  intent: 'book' | 'reschedule' | 'cancel' | 'faq' | 'other';
}

const LANGUAGE_NAMES: Record<string, string> = {
  'en-US': 'English',
  'de-DE': 'German',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'it-IT': 'Italian',
  'pt-BR': 'Portuguese',
  'nl-NL': 'Dutch',
};

// The language code stored in booking_rules also drives Twilio's <Say>/<Gather> voice
// (see routes/voice.ts) - keep this and that in sync so the AI's text and Twilio's
// spoken/recognized language always match.
export function resolveLanguage(settings: AISettingsRow): string {
  return settings.booking_rules?.language && LANGUAGE_NAMES[settings.booking_rules.language]
    ? settings.booking_rules.language
    : 'en-US';
}

function buildSystemPrompt(business: Business, settings: AISettingsRow): string {
  const assistantName = settings.booking_rules?.assistantName || 'the assistant';
  const today = new Date().toISOString().slice(0, 10);
  const languageName = LANGUAGE_NAMES[resolveLanguage(settings)];

  const servicesList = settings.services.length
    ? settings.services
        .map((s) => `- ${s.name} (${s.durationMinutes} min, €${s.price})`)
        .join('\n')
    : '(no specific services configured - treat any request as a general appointment)';

  const faqList = settings.faq.length
    ? settings.faq.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : '(no FAQ configured)';

  return `You are ${assistantName}, an AI phone receptionist for "${business.name}".
Today's date is ${today}. The business timezone is ${business.timezone}.

Speak and understand ${languageName} for this entire call. Every "say" value you return MUST
be written in ${languageName}, regardless of what language the caller uses.

Your job on this call: understand why the caller is calling, and if they want to book an
appointment, collect their name, which service they want, and a preferred date and time,
then hand off for booking. Keep responses short and natural, like a real receptionist -
one or two sentences per turn, no long lists read aloud.

Available services:
${servicesList}
${
  settings.services.length > 1
    ? `
Upselling: once the caller has confirmed their primary service, you may mention ONE other
service from the list above that pairs naturally with it (e.g. suggesting a service commonly
booked alongside it) - at most once per call, in a single short sentence, and only after the
primary service is settled. If the caller doesn't respond positively or seems in a hurry,
drop it immediately and continue the booking - never repeat the offer or push back. An
appointment can only hold one service at a time, so if they want the extra service too, book
whichever one they confirm first and let them know they're welcome to book the other
separately.`
    : ''
}

Frequently asked questions you can answer directly:
${faqList}

Booking rules: ${JSON.stringify(settings.booking_rules)}

You MUST respond with ONLY a JSON object (no markdown, no prose outside the JSON) with this
exact shape:
{
  "say": "<what to say next, spoken naturally>",
  "action": "continue" | "book_appointment" | "end_call",
  "booking": { "customerName": "...", "serviceName": "...", "date": "YYYY-MM-DD", "time": "HH:MM" } or null,
  "intent": "book" | "reschedule" | "cancel" | "faq" | "other"
}

Rules for "action":
- Use "continue" while you still need more information (e.g. you don't have a name, service,
  date, or time yet), or while just answering an FAQ and expecting more conversation.
- Use "book_appointment" ONLY once you have customerName, serviceName, date, AND time all
  confirmed by the caller. Fill in "booking" completely in this case, and make "say" a natural
  confirmation line (the system will actually create the booking after this).
- Use "end_call" if the caller is finished, says goodbye, or the call should end for any other
  reason (e.g. they only wanted an FAQ answered and have nothing else). Make "say" a brief,
  polite sign-off.
- Never invent information the caller hasn't given you. Ask for what's missing.
- If the caller asks something outside what you know, say you'll have someone follow up.`;
}

export async function getNextConversationTurn(
  business: Business,
  settings: AISettingsRow,
  turns: ConversationTurn[]
): Promise<GeminiTurnResult> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set - add it to .env');
  }

  const contents = turns.map((t) => ({
    role: t.role === 'caller' ? ('user' as const) : ('model' as const),
    parts: [{ text: t.text }],
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: buildSystemPrompt(business, settings) }],
        },
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as any;
  const rawText =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';

  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');

  try {
    const parsed = JSON.parse(cleaned);
    return {
      say: parsed.say || "I'm sorry, could you repeat that?",
      action:
        parsed.action === 'book_appointment' || parsed.action === 'end_call'
          ? parsed.action
          : 'continue',
      booking: parsed.booking || null,
      intent: ['book', 'reschedule', 'cancel', 'faq', 'other'].includes(parsed.intent)
        ? parsed.intent
        : 'other',
    };
  } catch {
    return {
      say: "I'm sorry, could you say that again?",
      action: 'continue',
      booking: null,
      intent: 'other',
    };
  }
}

// Best-effort: called after a call ends, from /voice/status. Never throws - a summary
// failure should never block logging the call itself. Returns null for a call with no
// real exchange (e.g. hung up before the caller said anything) or if the API call fails.
export async function generateCallSummary(turns: ConversationTurn[]): Promise<string | null> {
  const hasCallerSpeech = turns.some((t) => t.role === 'caller' && t.text.trim().length > 0);
  if (!GEMINI_API_KEY || !hasCallerSpeech) return null;

  const transcript = turns.map((t) => `${t.role}: ${t.text}`).join('\n');

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: 'Summarize this phone call transcript in ONE short sentence (max ~20 words) for a business owner skimming their call log. Plain text only, no markdown, no quotes around it. State what the caller wanted and the outcome.',
              },
            ],
          },
          contents: [{ role: 'user', parts: [{ text: transcript }] }],
        }),
      }
    );

    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err: any) {
    console.error('[gemini] call summary failed:', err.message);
    return null;
  }
}
