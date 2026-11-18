import { Router } from "express";
import twilio from "twilio";
import type TwilioVoiceResponse from "twilio/lib/twiml/VoiceResponse";
import * as Sentry from "@sentry/node";
import {
  getBusinessByPhoneNumber,
  getBusinessById,
  getAISettingsForBusiness,
  admitInboundCall,
} from "../services/business";
import {
  findCustomerByPhoneNumber,
  findOrCreateCustomer,
} from "../services/customers";
import {
  hasConflict,
  hasConflictExcludingAppointment,
  bookAppointment,
  getUpcomingAppointmentsForCustomer,
  rescheduleAppointment,
  cancelAppointment,
  SlotTakenError,
  type AppointmentRecord,
} from "../services/appointments";
import { logCall } from "../services/calls";
import { zonedToUtcDate, formatInZone } from "../utils/time";
import {
  createConversation,
  getConversation,
  updateConversation,
  deleteConversation,
} from "../services/conversationStore";
import {
  getNextConversationTurn,
  generateCallSummary,
  resolveLanguage,
  detectLanguageFromText,
} from "../services/gemini";
import { sendPushToBusinessMembers } from "../services/push";
import { requireTwilioSignature } from "../middleware/twilioSignature";

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

// Every route in this file is a Twilio webhook - reject anything without a valid
// X-Twilio-Signature up front (no-op when VALIDATE_TWILIO_SIGNATURE isn't "true").
router.use(requireTwilioSignature);

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:4001";
// Fallback for the handful of error paths that can fire before a business's AI settings
// (and therefore its configured language) have even been loaded.
const DEFAULT_LANGUAGE = "en-US";

const GOOGLE_VOICES = {
  "en-US": {
    female: "Google.en-US-Neural2-F",
    male: "Google.en-US-Neural2-D",
  },
  "de-DE": {
    female: "Google.de-DE-Neural2-A",
    male: "Google.de-DE-Neural2-B",
  },
  "es-ES": {
    female: "Google.es-ES-Neural2-A",
    male: "Google.es-ES-Neural2-C",
  },
  "fr-FR": {
    female: "Google.fr-FR-Neural2-A",
    male: "Google.fr-FR-Neural2-B",
  },
  "it-IT": {
    female: "Google.it-IT-Neural2-A",
    male: "Google.it-IT-Neural2-C",
  },
  "pt-BR": {
    female: "Google.pt-BR-Neural2-A",
    male: "Google.pt-BR-Neural2-B",
  },
  "nl-NL": {
    female: "Google.nl-NL-Wavenet-A",
    male: "Google.nl-NL-Wavenet-B",
  },
} satisfies Record<
  string,
  {
    female: TwilioVoiceResponse.SayAttributes["voice"];
    male: TwilioVoiceResponse.SayAttributes["voice"];
  }
>;

function getVoice(language: string, voiceId = "default") {
  const voices =
    GOOGLE_VOICES[language as keyof typeof GOOGLE_VOICES] ??
    GOOGLE_VOICES[DEFAULT_LANGUAGE];
  return voiceId === "mike" || voiceId === "alex"
    ? voices.male
    : voices.female;
}

// Prepended to the opening greeting only (not every turn) - several jurisdictions
// (e.g. California's bot-disclosure law, EU AI Act transparency rules) expect a caller
// to be told up front they're talking to an AI, not a human.
const AI_DISCLOSURE: Record<string, string> = {
  "en-US": "This call is handled by an AI assistant.",
  "de-DE": "Dieser Anruf wird von einem KI-Assistenten bearbeitet.",
  "es-ES": "Esta llamada la atiende un asistente de inteligencia artificial.",
  "fr-FR": "Cet appel est pris en charge par un assistant IA.",
  "it-IT": "Questa chiamata è gestita da un assistente IA.",
  "pt-BR": "Esta chamada é atendida por um assistente de IA.",
  "nl-NL": "Dit gesprek wordt afgehandeld door een AI-assistent.",
};

const RETURNING_CUSTOMER_GREETING: Record<
  string,
  (customerName: string) => string
> = {
  "en-US": (customerName) => `Welcome back, ${customerName}.`,
  "de-DE": (customerName) => `Willkommen zurück, ${customerName}.`,
  "es-ES": (customerName) => `Bienvenido de nuevo, ${customerName}.`,
  "fr-FR": (customerName) => `Bienvenue à nouveau, ${customerName}.`,
  "it-IT": (customerName) => `Bentornato, ${customerName}.`,
  "pt-BR": (customerName) => `Bem-vindo de volta, ${customerName}.`,
  "nl-NL": (customerName) => `Welkom terug, ${customerName}.`,
};

function withAiDisclosure(greeting: string, language: string) {
  const disclosure = AI_DISCLOSURE[language] ?? AI_DISCLOSURE[DEFAULT_LANGUAGE];
  return `${disclosure} ${greeting}`;
}

function getReturningCustomerGreeting(customerName: string, language: string) {
  const formatter =
    RETURNING_CUSTOMER_GREETING[language] ??
    RETURNING_CUSTOMER_GREETING[DEFAULT_LANGUAGE];
  return formatter(customerName);
}

const MULTI_APPOINTMENT_CLARIFICATION: Record<
  string,
  (count: number, action: "reschedule" | "cancel", choices: string) => string
> = {
  "en-US": (count, action, choices) =>
    `I found ${count} upcoming appointments. Please pick which one you want to ${action} by number or date and time: ${choices}`,
  "de-DE": (count, action, choices) =>
    `Ich habe ${count} bevorstehende Termine gefunden. Bitte sagen Sie mir, welchen Sie ${action === "reschedule" ? "verschieben" : "stornieren"} möchten — nennen Sie die Nummer oder Datum und Uhrzeit: ${choices}`,
};

function buildMultiAppointmentClarificationText(
  appointments: AppointmentRecord[],
  action: "reschedule" | "cancel",
  language: string,
  timezone: string,
) {
  const choices = appointments
    .map((appointment, index) => {
      const when = formatInZone(
        appointment.start_time,
        timezone,
        language.slice(0, 2),
      );
      return `${index + 1}. ${when}`;
    })
    .join(" | ");

  const formatter =
    MULTI_APPOINTMENT_CLARIFICATION[language] ??
    MULTI_APPOINTMENT_CLARIFICATION["en-US"];
  return formatter(appointments.length, action, choices);
}

const NO_SPEECH_TEXT: Record<string, string> = {
  "en-US": "I didn't catch that. Goodbye for now.",
  "de-DE": "Ich habe das nicht verstanden. Auf Wiederhören.",
  "es-ES": "No le he entendido. Hasta pronto.",
  "fr-FR": "Je n'ai pas compris. Au revoir.",
  "it-IT": "Non ho capito. Arrivederci.",
  "pt-BR": "Não entendi. Até logo.",
  "nl-NL": "Ik heb dat niet begrepen. Tot ziens.",
};

// Used when a booking conflict is detected outside the LLM turn (see /voice/gather) -
// this bypasses Gemini entirely so it needs its own per-language text.
const TIME_TAKEN_TEXT: Record<string, string> = {
  "en-US": "That time is actually just taken. Could you pick a different time?",
  "de-DE":
    "Dieser Termin ist leider gerade vergeben. Könnten Sie eine andere Uhrzeit wählen?",
  "es-ES": "Esa hora ya está ocupada. ¿Podría elegir otra hora?",
  "fr-FR":
    "Ce créneau vient d'être pris. Pourriez-vous choisir un autre horaire ?",
  "it-IT":
    "Quell'orario è appena stato preso. Potrebbe scegliere un altro orario?",
  "pt-BR":
    "Esse horário acabou de ser reservado. Poderia escolher outro horário?",
  "nl-NL": "Dat tijdstip is net bezet. Kunt u een andere tijd kiezen?",
};

// Opening line for an automatic follow-up call (see jobs/followups.ts) - references the
// earlier call so it doesn't sound like a cold call.
const FOLLOWUP_GREETING: Record<
  string,
  (assistantName: string, businessName: string) => string
> = {
  "en-US": (a, b) =>
    `Hi, this is ${a} calling from ${b}. We spoke a little earlier - are you still interested in booking an appointment?`,
  "de-DE": (a, b) =>
    `Hallo, hier ist ${a} von ${b}. Wir haben vorhin schon gesprochen - sind Sie noch an einem Termin interessiert?`,
  "es-ES": (a, b) =>
    `Hola, soy ${a} de ${b}. Hablamos hace un momento - ¿le sigue interesando reservar una cita?`,
  "fr-FR": (a, b) =>
    `Bonjour, c'est ${a} de ${b}. Nous avons parlé un peu plus tôt - êtes-vous toujours intéressé par une réservation?`,
  "it-IT": (a, b) =>
    `Ciao, sono ${a} di ${b}. Abbiamo parlato poco fa - è ancora interessato a prenotare un appuntamento?`,
  "pt-BR": (a, b) =>
    `Oi, aqui é ${a} da ${b}. Conversamos há pouco - ainda tem interesse em marcar um horário?`,
  "nl-NL": (a, b) =>
    `Hallo, dit is ${a} namens ${b}. We spraken elkaar net al even - heeft u nog interesse in een afspraak?`,
};

// Twilio's generated types pin `language` to a closed enum per verb (SayLanguage /
// GatherLanguage) rather than a shared string type. We only ever pass one of the fixed
// codes in gemini.ts's LANGUAGE_NAMES map, all of which are valid Twilio language codes,
// so the cast here is safe - it's a type-system mismatch between two Twilio enums, not a
// runtime concern.
function sayAndHangup(
  text: string,
  language: string = DEFAULT_LANGUAGE,
  voiceId = "default",
) {
  const twiml = new VoiceResponse();
  twiml.say({ language: language as any, voice: getVoice(language, voiceId) }, text);
  twiml.hangup();
  return twiml.toString();
}

function sayAndGather(
  text: string,
  language: string = DEFAULT_LANGUAGE,
  voiceId = "default",
) {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: ["speech"],
    action: `${PUBLIC_BASE_URL}/voice/gather`,
    method: "POST",
    speechTimeout: "auto",
    language: language as any,
  });
  gather.say({ language: language as any, voice: getVoice(language, voiceId) }, text);
  // If Twilio's Gather times out with no speech at all, it falls through to here.
  twiml.say(
    { language: language as any, voice: getVoice(language, voiceId) },
    NO_SPEECH_TEXT[language] ?? NO_SPEECH_TEXT[DEFAULT_LANGUAGE],
  );
  twiml.hangup();
  return twiml.toString();
}

// POST /voice/incoming - Twilio hits this the moment a call connects.
router.post("/incoming", async (req, res) => {
  const callSid = req.body.CallSid as string;
  const to = req.body.To as string; // the business's Twilio number
  const from = req.body.From as string; // the caller's number

  try {
    const business = await getBusinessByPhoneNumber(to);
    if (!business) {
      res.type("text/xml");
      return res.send(
        sayAndHangup("Sorry, this number is not currently set up. Goodbye."),
      );
    }

    const settings = await getAISettingsForBusiness(business.id);
    if (!settings) {
      res.type("text/xml");
      return res.send(
        sayAndHangup("Sorry, this business is not fully set up yet. Goodbye."),
      );
    }

    const admitted = await admitInboundCall(callSid, business.id, from);
    if (!admitted) {
      res.type("text/xml");
      return res.send(
        sayAndHangup(
          "Sorry, this business is unable to take more calls right now. Please contact the business directly."
        )
      );
    }

    const customer = await findCustomerByPhoneNumber(business.id, from);
    const language = resolveLanguage(settings);
    const openingGreeting = customer?.full_name
      ? `${settings.greeting} ${getReturningCustomerGreeting(customer.full_name, language)}`
      : settings.greeting;

    createConversation({
      callSid,
      businessId: business.id,
      callerNumber: from,
      businessName: business.name,
      turns: [{ role: "assistant", text: openingGreeting }],
      intent: "other",
      resultedInAppointmentId: null,
      startedAt: Date.now(),
      direction: "inbound",
    });

    res.type("text/xml");
    res.send(
      sayAndGather(
        withAiDisclosure(openingGreeting, language),
        language,
        settings.voice_id,
      ),
    );
  } catch (err: any) {
    console.error("[voice/incoming] error:", err.message);
    Sentry.captureException(err);
    res.type("text/xml");
    res.send(
      sayAndHangup("Sorry, something went wrong. Please try again later."),
    );
  }
});

// POST /voice/followup-connect - Twilio hits this when an automatic follow-up call we
// placed (see jobs/followups.ts) actually connects. `From` is our business's own number
// (the caller ID we dialed out with), looked up the exact same way /voice/incoming does
// - so from here on the call behaves exactly like an inbound one: /voice/gather handles
// every next turn the same way, and booking/upselling/push notifications all work
// unchanged.
router.post("/followup-connect", async (req, res) => {
  const callSid = req.body.CallSid as string;
  const customerNumber = req.body.To as string; // the number we called
  const businessNumber = req.body.From as string; // our own caller ID

  try {
    const business = await getBusinessByPhoneNumber(businessNumber);
    const settings = business
      ? await getAISettingsForBusiness(business.id)
      : null;
    if (!business || !settings) {
      res.type("text/xml");
      return res.send(sayAndHangup("Sorry, something went wrong. Goodbye."));
    }

    const language = resolveLanguage(settings);
    const assistantName =
      settings.booking_rules?.assistantName || "the assistant";
    const greeting = (
      FOLLOWUP_GREETING[language] ?? FOLLOWUP_GREETING[DEFAULT_LANGUAGE]
    )(assistantName, business.name);

    createConversation({
      callSid,
      businessId: business.id,
      callerNumber: customerNumber,
      businessName: business.name,
      turns: [{ role: "assistant", text: greeting }],
      intent: "other",
      resultedInAppointmentId: null,
      startedAt: Date.now(),
      direction: "outbound",
    });

    res.type("text/xml");
    res.send(
      sayAndGather(
        withAiDisclosure(greeting, language),
        language,
        settings.voice_id,
      ),
    );
  } catch (err: any) {
    console.error("[voice/followup-connect] error:", err.message);
    Sentry.captureException(err);
    res.type("text/xml");
    res.send(sayAndHangup("Sorry, something went wrong. Goodbye."));
  }
});

// POST /voice/gather - Twilio hits this after each utterance from the caller.
router.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid as string;
  const speechResult = (req.body.SpeechResult as string) || "";

  const conversation = getConversation(callSid);
  if (!conversation) {
    res.type("text/xml");
    return res.send(sayAndHangup("Sorry, I lost track of this call. Goodbye."));
  }

  try {
    // Uses conversation.businessId (set at creation, for both inbound and outbound
    // calls) rather than re-deriving the business from req.body.To - that field is the
    // *business's* number on an inbound call but the *customer's* number on an outbound
    // follow-up call (see /voice/followup-connect), so looking it up by phone here would
    // silently fail to find the business on every follow-up call's second turn onward.
    const settingsPromise = getAISettingsForBusiness(conversation.businessId);
    const businessPromise = getBusinessById(conversation.businessId);
    const [settings, business] = await Promise.all([
      settingsPromise,
      businessPromise,
    ]);

    if (!settings || !business) {
      res.type("text/xml");
      return res.send(sayAndHangup("Sorry, something went wrong. Goodbye."));
    }

    const language = resolveLanguage(settings);
    const voiceId = settings.voice_id || "default";
    const responseLanguage = detectLanguageFromText(speechResult, language);
    // Dates the caller speaks ("Monday at 3pm") are read in the business's own timezone,
    // never the server's (Render runs in UTC, which would shift every booking by 1-2h).
    const timezone = business.timezone || "Europe/Berlin";
    const turns = [
      ...conversation.turns,
      { role: "caller" as const, text: speechResult },
    ];
    const result = await getNextConversationTurn(business, settings, turns);

    turns.push({ role: "assistant", text: result.say });

    updateConversation(callSid, { turns, intent: result.intent });

    if (
      result.action === "book_appointment" &&
      result.booking?.date &&
      result.booking?.time
    ) {
      const service = settings.services.find(
        (s) => s.name === result.booking?.serviceName,
      );
      const durationMinutes = service?.durationMinutes ?? 60;

      const start = zonedToUtcDate(
        result.booking.date,
        result.booking.time,
        timezone,
      );
      const end = new Date(start.getTime() + durationMinutes * 60000);

      const conflict = await hasConflict(
        conversation.businessId,
        start.toISOString(),
        end.toISOString(),
      );

      if (conflict) {
        const retryText =
          TIME_TAKEN_TEXT[language] ?? TIME_TAKEN_TEXT[DEFAULT_LANGUAGE];
        turns[turns.length - 1] = { role: "assistant", text: retryText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(retryText, language, voiceId));
      }

      const customer = await findOrCreateCustomer(
        conversation.businessId,
        conversation.callerNumber,
        result.booking.customerName,
      );

      // The pre-check above covers the normal case; the database's overlap constraint
      // catches two calls grabbing the same slot at the same moment.
      let appointment: Awaited<ReturnType<typeof bookAppointment>>;
      try {
        appointment = await bookAppointment({
          businessId: conversation.businessId,
          customerId: customer.id,
          serviceName: result.booking.serviceName,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        });
      } catch (err) {
        if (err instanceof SlotTakenError) {
          const retryText =
            TIME_TAKEN_TEXT[language] ?? TIME_TAKEN_TEXT[DEFAULT_LANGUAGE];
          turns[turns.length - 1] = { role: "assistant", text: retryText };
          updateConversation(callSid, { turns });
          res.type("text/xml");
          return res.send(sayAndGather(retryText, language, voiceId));
        }
        throw err;
      }

      updateConversation(callSid, { resultedInAppointmentId: appointment.id });

      sendPushToBusinessMembers(
        conversation.businessId,
        "New appointment booked by AI",
        `${customer.full_name} - ${result.booking.serviceName || "Appointment"} on ${formatInZone(start, timezone)}`,
        { appointmentId: appointment.id },
      ).catch((err) => {
        console.error("[voice/gather] push send failed:", err.message);
        Sentry.captureException(err);
      });

      res.type("text/xml");
      return res.send(sayAndHangup(result.say, language, voiceId));
    }

    if (result.action === "reschedule_appointment") {
      const customer = await findCustomerByPhoneNumber(
        conversation.businessId,
        conversation.callerNumber,
      );
      if (!customer) {
        const fallbackText =
          "I could not find an existing appointment for your phone number. Please try again later or ask to book a new appointment.";
        turns[turns.length - 1] = { role: "assistant", text: fallbackText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(fallbackText, language, voiceId));
      }

      const upcomingAppointments = await getUpcomingAppointmentsForCustomer(
        conversation.businessId,
        customer.id,
      );

      if (!upcomingAppointments.length) {
        const fallbackText =
          "I could not find an upcoming appointment to reschedule.";
        turns[turns.length - 1] = { role: "assistant", text: fallbackText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(fallbackText, language, voiceId));
      }

      if (upcomingAppointments.length > 1) {
        const optionsText = buildMultiAppointmentClarificationText(
          upcomingAppointments,
          "reschedule",
          responseLanguage,
          timezone,
        );
        turns[turns.length - 1] = { role: "assistant", text: optionsText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(optionsText, responseLanguage, voiceId));
      }

      if (!result.booking?.date || !result.booking?.time) {
        const fallbackText = "What date and time would you like to move it to?";
        turns[turns.length - 1] = { role: "assistant", text: fallbackText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(fallbackText, language, voiceId));
      }

      const target = upcomingAppointments[0];
      const start = zonedToUtcDate(
        result.booking.date,
        result.booking.time,
        timezone,
      );
      const end = new Date(start.getTime() + 60 * 60000);
      const conflict = await hasConflictExcludingAppointment(
        conversation.businessId,
        start.toISOString(),
        end.toISOString(),
        target.id,
      );

      if (conflict) {
        const retryText =
          TIME_TAKEN_TEXT[language] ?? TIME_TAKEN_TEXT[DEFAULT_LANGUAGE];
        turns[turns.length - 1] = { role: "assistant", text: retryText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(retryText, language, voiceId));
      }

      try {
        await rescheduleAppointment(
          target.id,
          start.toISOString(),
          end.toISOString(),
        );
      } catch (err) {
        if (err instanceof SlotTakenError) {
          const retryText =
            TIME_TAKEN_TEXT[language] ?? TIME_TAKEN_TEXT[DEFAULT_LANGUAGE];
          turns[turns.length - 1] = { role: "assistant", text: retryText };
          updateConversation(callSid, { turns });
          res.type("text/xml");
          return res.send(sayAndGather(retryText, language, voiceId));
        }
        throw err;
      }

      updateConversation(callSid, { resultedInAppointmentId: target.id });
      res.type("text/xml");
      return res.send(sayAndHangup(result.say, language, voiceId));
    }

    if (result.action === "cancel_appointment") {
      const customer = await findCustomerByPhoneNumber(
        conversation.businessId,
        conversation.callerNumber,
      );
      if (!customer) {
        const fallbackText =
          "I could not find an existing appointment for your phone number to cancel.";
        turns[turns.length - 1] = { role: "assistant", text: fallbackText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(fallbackText, language, voiceId));
      }

      const upcomingAppointments = await getUpcomingAppointmentsForCustomer(
        conversation.businessId,
        customer.id,
      );

      if (!upcomingAppointments.length) {
        const fallbackText =
          "I could not find an upcoming appointment to cancel.";
        turns[turns.length - 1] = { role: "assistant", text: fallbackText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(fallbackText, language, voiceId));
      }

      if (upcomingAppointments.length > 1) {
        const optionsText = buildMultiAppointmentClarificationText(
          upcomingAppointments,
          "cancel",
          responseLanguage,
          timezone,
        );
        turns[turns.length - 1] = { role: "assistant", text: optionsText };
        updateConversation(callSid, { turns });
        res.type("text/xml");
        return res.send(sayAndGather(optionsText, responseLanguage, voiceId));
      }

      const target = upcomingAppointments[0];
      await cancelAppointment(target.id);
      updateConversation(callSid, { resultedInAppointmentId: target.id });
      res.type("text/xml");
      return res.send(sayAndHangup(result.say, language, voiceId));
    }

    if (result.action === "end_call") {
      res.type("text/xml");
      return res.send(sayAndHangup(result.say, language, voiceId));
    }

    res.type("text/xml");
    res.send(sayAndGather(result.say, responseLanguage, voiceId));
  } catch (err: any) {
    console.error("[voice/gather] error:", err.message);
    Sentry.captureException(err);
    res.type("text/xml");
    res.send(sayAndHangup("Sorry, something went wrong on my end. Goodbye."));
  }
});

// POST /voice/status - Twilio's statusCallback, fires when the call actually ends
// (however it ended: hangup, no-answer, busy, failed). This is the authoritative
// place we log the call record, since it fires reliably in every case.
router.post("/status", async (req, res) => {
  const callSid = req.body.CallSid as string;
  const callStatus = req.body.CallStatus as string; // completed | no-answer | busy | failed | canceled
  const durationSeconds = Number(req.body.CallDuration || 0);

  const conversation = getConversation(callSid);
  res.sendStatus(200); // acknowledge immediately, Twilio doesn't need the body

  if (!conversation) return; // e.g. call never made it into /voice/incoming

  const statusMap: Record<string, "completed" | "missed" | "failed"> = {
    completed: "completed",
    "no-answer": "missed",
    busy: "missed",
    failed: "failed",
    canceled: "missed",
  };

  try {
    const customerLookup = await findOrCreateCustomer(
      conversation.businessId,
      conversation.callerNumber,
    ).catch(() => null);

    const summary = await generateCallSummary(conversation.turns).catch(
      () => null,
    );
    const finalStatus = statusMap[callStatus] || "completed";

    // The caller wanted to book but the call ended without one - a candidate for
    // jobs/followups.ts to call back later. A call that never connected (missed/failed)
    // never gets intent='book' in the first place (conversationStore defaults to
    // 'other'), so this naturally excludes those without an extra check. A follow-up
    // call itself never spawns another follow-up, so we don't call someone forever.
    const needsFollowup =
      conversation.direction === "inbound" &&
      conversation.intent === "book" &&
      !conversation.resultedInAppointmentId &&
      finalStatus === "completed";

    await logCall({
      callSid,
      businessId: conversation.businessId,
      customerId: customerLookup?.id ?? null,
      callerNumber: conversation.callerNumber,
      status: finalStatus,
      durationSeconds,
      intent: conversation.intent,
      transcript: conversation.turns
        .map((t) => `${t.role}: ${t.text}`)
        .join("\n"),
      summary,
      resultedInAppointmentId: conversation.resultedInAppointmentId,
      needsFollowup,
      direction: conversation.direction,
      quotaReserved: conversation.direction === "inbound",
    });
  } catch (err: any) {
    console.error("[voice/status] failed to log call:", err.message);
    Sentry.captureException(err);
  } finally {
    deleteConversation(callSid);
  }
});

export default router;