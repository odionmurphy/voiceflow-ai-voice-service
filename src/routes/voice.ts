import { Router } from 'express';
import twilio from 'twilio';
import * as Sentry from '@sentry/node';
import { getBusinessByPhoneNumber, getBusinessById, getAISettingsForBusiness } from '../services/business';
import { findOrCreateCustomer } from '../services/customers';
import { hasConflict, bookAppointment } from '../services/appointments';
import { logCall } from '../services/calls';
import {
  createConversation,
  getConversation,
  updateConversation,
  deleteConversation,
} from '../services/conversationStore';
import { getNextConversationTurn, generateCallSummary, resolveLanguage } from '../services/gemini';
import { sendPushToBusinessMembers } from '../services/push';

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:4001';
// Fallback for the handful of error paths that can fire before a business's AI settings
// (and therefore its configured language) have even been loaded.
const DEFAULT_LANGUAGE = 'en-US';

const NO_SPEECH_TEXT: Record<string, string> = {
  'en-US': "I didn't catch that. Goodbye for now.",
  'de-DE': 'Ich habe das nicht verstanden. Auf Wiederhören.',
  'es-ES': 'No le he entendido. Hasta pronto.',
  'fr-FR': "Je n'ai pas compris. Au revoir.",
  'it-IT': 'Non ho capito. Arrivederci.',
  'pt-BR': 'Não entendi. Até logo.',
  'nl-NL': 'Ik heb dat niet begrepen. Tot ziens.',
};

// Used when a booking conflict is detected outside the LLM turn (see /voice/gather) -
// this bypasses Gemini entirely so it needs its own per-language text.
const TIME_TAKEN_TEXT: Record<string, string> = {
  'en-US': 'That time is actually just taken. Could you pick a different time?',
  'de-DE': 'Dieser Termin ist leider gerade vergeben. Könnten Sie eine andere Uhrzeit wählen?',
  'es-ES': 'Esa hora ya está ocupada. ¿Podría elegir otra hora?',
  'fr-FR': 'Ce créneau vient d\'être pris. Pourriez-vous choisir un autre horaire ?',
  'it-IT': "Quell'orario è appena stato preso. Potrebbe scegliere un altro orario?",
  'pt-BR': 'Esse horário acabou de ser reservado. Poderia escolher outro horário?',
  'nl-NL': 'Dat tijdstip is net bezet. Kunt u een andere tijd kiezen?',
};

// Opening line for an automatic follow-up call (see jobs/followups.ts) - references the
// earlier call so it doesn't sound like a cold call.
const FOLLOWUP_GREETING: Record<string, (assistantName: string, businessName: string) => string> = {
  'en-US': (a, b) => `Hi, this is ${a} calling from ${b}. We spoke a little earlier - are you still interested in booking an appointment?`,
  'de-DE': (a, b) => `Hallo, hier ist ${a} von ${b}. Wir haben vorhin schon gesprochen - sind Sie noch an einem Termin interessiert?`,
  'es-ES': (a, b) => `Hola, soy ${a} de ${b}. Hablamos hace un momento - ¿le sigue interesando reservar una cita?`,
  'fr-FR': (a, b) => `Bonjour, c'est ${a} de ${b}. Nous avons parlé un peu plus tôt - êtes-vous toujours intéressé par une réservation?`,
  'it-IT': (a, b) => `Ciao, sono ${a} di ${b}. Abbiamo parlato poco fa - è ancora interessato a prenotare un appuntamento?`,
  'pt-BR': (a, b) => `Oi, aqui é ${a} da ${b}. Conversamos há pouco - ainda tem interesse em marcar um horário?`,
  'nl-NL': (a, b) => `Hallo, dit is ${a} namens ${b}. We spraken elkaar net al even - heeft u nog interesse in een afspraak?`,
};

// Twilio's generated types pin `language` to a closed enum per verb (SayLanguage /
// GatherLanguage) rather than a shared string type. We only ever pass one of the fixed
// codes in gemini.ts's LANGUAGE_NAMES map, all of which are valid Twilio language codes,
// so the cast here is safe - it's a type-system mismatch between two Twilio enums, not a
// runtime concern.
function sayAndHangup(text: string, language: string = DEFAULT_LANGUAGE) {
  const twiml = new VoiceResponse();
  twiml.say({ language: language as any }, text);
  twiml.hangup();
  return twiml.toString();
}

function sayAndGather(text: string, language: string = DEFAULT_LANGUAGE) {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: ['speech'],
    action: `${PUBLIC_BASE_URL}/voice/gather`,
    method: 'POST',
    speechTimeout: 'auto',
    language: language as any,
  });
  gather.say({ language: language as any }, text);
  // If Twilio's Gather times out with no speech at all, it falls through to here.
  twiml.say({ language: language as any }, NO_SPEECH_TEXT[language] ?? NO_SPEECH_TEXT[DEFAULT_LANGUAGE]);
  twiml.hangup();
  return twiml.toString();
}

// POST /voice/incoming - Twilio hits this the moment a call connects.
router.post('/incoming', async (req, res) => {
  const callSid = req.body.CallSid as string;
  const to = req.body.To as string; // the business's Twilio number
  const from = req.body.From as string; // the caller's number

  try {
    const business = await getBusinessByPhoneNumber(to);
    if (!business) {
      res.type('text/xml');
      return res.send(
        sayAndHangup('Sorry, this number is not currently set up. Goodbye.')
      );
    }

    const settings = await getAISettingsForBusiness(business.id);
    if (!settings) {
      res.type('text/xml');
      return res.send(
        sayAndHangup('Sorry, this business is not fully set up yet. Goodbye.')
      );
    }

    createConversation({
      callSid,
      businessId: business.id,
      callerNumber: from,
      businessName: business.name,
      turns: [{ role: 'assistant', text: settings.greeting }],
      intent: 'other',
      resultedInAppointmentId: null,
      startedAt: Date.now(),
      direction: 'inbound',
    });

    res.type('text/xml');
    res.send(sayAndGather(settings.greeting, resolveLanguage(settings)));
  } catch (err: any) {
    console.error('[voice/incoming] error:', err.message);
    Sentry.captureException(err);
    res.type('text/xml');
    res.send(sayAndHangup('Sorry, something went wrong. Please try again later.'));
  }
});

// POST /voice/followup-connect - Twilio hits this when an automatic follow-up call we
// placed (see jobs/followups.ts) actually connects. `From` is our business's own number
// (the caller ID we dialed out with), looked up the exact same way /voice/incoming does
// - so from here on the call behaves exactly like an inbound one: /voice/gather handles
// every next turn the same way, and booking/upselling/push notifications all work
// unchanged.
router.post('/followup-connect', async (req, res) => {
  const callSid = req.body.CallSid as string;
  const customerNumber = req.body.To as string; // the number we called
  const businessNumber = req.body.From as string; // our own caller ID

  try {
    const business = await getBusinessByPhoneNumber(businessNumber);
    const settings = business ? await getAISettingsForBusiness(business.id) : null;
    if (!business || !settings) {
      res.type('text/xml');
      return res.send(sayAndHangup('Sorry, something went wrong. Goodbye.'));
    }

    const language = resolveLanguage(settings);
    const assistantName = settings.booking_rules?.assistantName || 'the assistant';
    const greeting = (FOLLOWUP_GREETING[language] ?? FOLLOWUP_GREETING[DEFAULT_LANGUAGE])(
      assistantName,
      business.name
    );

    createConversation({
      callSid,
      businessId: business.id,
      callerNumber: customerNumber,
      businessName: business.name,
      turns: [{ role: 'assistant', text: greeting }],
      intent: 'other',
      resultedInAppointmentId: null,
      startedAt: Date.now(),
      direction: 'outbound',
    });

    res.type('text/xml');
    res.send(sayAndGather(greeting, language));
  } catch (err: any) {
    console.error('[voice/followup-connect] error:', err.message);
    Sentry.captureException(err);
    res.type('text/xml');
    res.send(sayAndHangup('Sorry, something went wrong. Goodbye.'));
  }
});

// POST /voice/gather - Twilio hits this after each utterance from the caller.
router.post('/gather', async (req, res) => {
  const callSid = req.body.CallSid as string;
  const speechResult = (req.body.SpeechResult as string) || '';

  const conversation = getConversation(callSid);
  if (!conversation) {
    res.type('text/xml');
    return res.send(sayAndHangup('Sorry, I lost track of this call. Goodbye.'));
  }

  try {
    // Uses conversation.businessId (set at creation, for both inbound and outbound
    // calls) rather than re-deriving the business from req.body.To - that field is the
    // *business's* number on an inbound call but the *customer's* number on an outbound
    // follow-up call (see /voice/followup-connect), so looking it up by phone here would
    // silently fail to find the business on every follow-up call's second turn onward.
    const settingsPromise = getAISettingsForBusiness(conversation.businessId);
    const businessPromise = getBusinessById(conversation.businessId);
    const [settings, business] = await Promise.all([settingsPromise, businessPromise]);

    if (!settings || !business) {
      res.type('text/xml');
      return res.send(sayAndHangup('Sorry, something went wrong. Goodbye.'));
    }

    const language = resolveLanguage(settings);
    const turns = [...conversation.turns, { role: 'caller' as const, text: speechResult }];
    const result = await getNextConversationTurn(business, settings, turns);
    turns.push({ role: 'assistant', text: result.say });

    updateConversation(callSid, { turns, intent: result.intent });

    if (result.action === 'book_appointment' && result.booking?.date && result.booking?.time) {
      const service = settings.services.find((s) => s.name === result.booking?.serviceName);
      const durationMinutes = service?.durationMinutes ?? 60;

      // NOTE: constructs the time using this server's local timezone. Fine when this
      // service runs in the same timezone as the business (typical for a single-region
      // MVP). For multi-region use, swap in a proper timezone library (e.g. luxon) using
      // business.timezone.
      const start = new Date(`${result.booking.date}T${result.booking.time}:00`);
      const end = new Date(start.getTime() + durationMinutes * 60000);

      const conflict = await hasConflict(conversation.businessId, start.toISOString(), end.toISOString());

      if (conflict) {
        const retryText = TIME_TAKEN_TEXT[language] ?? TIME_TAKEN_TEXT[DEFAULT_LANGUAGE];
        turns[turns.length - 1] = { role: 'assistant', text: retryText };
        updateConversation(callSid, { turns });
        res.type('text/xml');
        return res.send(sayAndGather(retryText, language));
      }

      const customer = await findOrCreateCustomer(
        conversation.businessId,
        conversation.callerNumber,
        result.booking.customerName
      );

      const appointment = await bookAppointment({
        businessId: conversation.businessId,
        customerId: customer.id,
        serviceName: result.booking.serviceName,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });

      updateConversation(callSid, { resultedInAppointmentId: appointment.id });

      sendPushToBusinessMembers(
        conversation.businessId,
        'New appointment booked by AI',
        `${customer.full_name} - ${result.booking.serviceName || 'Appointment'} on ${start.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        { appointmentId: appointment.id }
      ).catch((err) => {
        console.error('[voice/gather] push send failed:', err.message);
        Sentry.captureException(err);
      });

      res.type('text/xml');
      return res.send(sayAndHangup(result.say, language));
    }

    if (result.action === 'end_call') {
      res.type('text/xml');
      return res.send(sayAndHangup(result.say, language));
    }

    res.type('text/xml');
    res.send(sayAndGather(result.say, language));
  } catch (err: any) {
    console.error('[voice/gather] error:', err.message);
    Sentry.captureException(err);
    res.type('text/xml');
    res.send(sayAndHangup('Sorry, something went wrong on my end. Goodbye.'));
  }
});

// POST /voice/status - Twilio's statusCallback, fires when the call actually ends
// (however it ended: hangup, no-answer, busy, failed). This is the authoritative
// place we log the call record, since it fires reliably in every case.
router.post('/status', async (req, res) => {
  const callSid = req.body.CallSid as string;
  const callStatus = req.body.CallStatus as string; // completed | no-answer | busy | failed | canceled
  const durationSeconds = Number(req.body.CallDuration || 0);

  const conversation = getConversation(callSid);
  res.sendStatus(200); // acknowledge immediately, Twilio doesn't need the body

  if (!conversation) return; // e.g. call never made it into /voice/incoming

  const statusMap: Record<string, 'completed' | 'missed' | 'failed'> = {
    completed: 'completed',
    'no-answer': 'missed',
    busy: 'missed',
    failed: 'failed',
    canceled: 'missed',
  };

  try {
    const customerLookup = await findOrCreateCustomer(
      conversation.businessId,
      conversation.callerNumber
    ).catch(() => null);

    const summary = await generateCallSummary(conversation.turns).catch(() => null);
    const finalStatus = statusMap[callStatus] || 'completed';

    // The caller wanted to book but the call ended without one - a candidate for
    // jobs/followups.ts to call back later. A call that never connected (missed/failed)
    // never gets intent='book' in the first place (conversationStore defaults to
    // 'other'), so this naturally excludes those without an extra check. A follow-up
    // call itself never spawns another follow-up, so we don't call someone forever.
    const needsFollowup =
      conversation.direction === 'inbound' &&
      conversation.intent === 'book' &&
      !conversation.resultedInAppointmentId &&
      finalStatus === 'completed';

    await logCall({
      businessId: conversation.businessId,
      customerId: customerLookup?.id ?? null,
      callerNumber: conversation.callerNumber,
      status: finalStatus,
      durationSeconds,
      intent: conversation.intent,
      transcript: conversation.turns.map((t) => `${t.role}: ${t.text}`).join('\n'),
      summary,
      resultedInAppointmentId: conversation.resultedInAppointmentId,
      needsFollowup,
      direction: conversation.direction,
    });
  } catch (err: any) {
    console.error('[voice/status] failed to log call:', err.message);
    Sentry.captureException(err);
  } finally {
    deleteConversation(callSid);
  }
});

export default router;
