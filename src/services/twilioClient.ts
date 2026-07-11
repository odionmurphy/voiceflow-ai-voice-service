import twilio from 'twilio';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

export function isTwilioCallingConfigured() {
  return !!ACCOUNT_SID && !!AUTH_TOKEN;
}

// Lazy, mirrors backend/src/services/stripe.ts's client() - constructing with an empty
// SID/token throws immediately, and callers already check isTwilioCallingConfigured().
let _client: ReturnType<typeof twilio> | null = null;
function client(): ReturnType<typeof twilio> {
  if (!_client) _client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  return _client;
}

// Places a real outbound phone call - this costs money and rings a real phone. Callers
// (jobs/followups.ts) are responsible for only calling this when a human has explicitly
// opted into automatic follow-up calls (FOLLOWUP_CALLS_ENABLED=true).
export async function placeOutboundCall(params: {
  to: string;
  from: string;
  connectUrl: string;
  statusCallbackUrl: string;
}): Promise<string> {
  const call = await client().calls.create({
    to: params.to,
    from: params.from,
    url: params.connectUrl,
    method: 'POST',
    statusCallback: params.statusCallbackUrl,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['completed'],
  });
  return call.sid;
}
