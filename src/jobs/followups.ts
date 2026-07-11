import { query } from '../config/db';
import { placeOutboundCall, isTwilioCallingConfigured } from '../services/twilioClient';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:4001';
const FOLLOWUP_DELAY_MINUTES = Number(process.env.FOLLOWUP_DELAY_MINUTES || 15);
const FOLLOWUP_POLL_MINUTES = Number(process.env.FOLLOWUP_POLL_MINUTES || 15);

// This places real, billed outbound phone calls. Off by default - only starts if
// FOLLOWUP_CALLS_ENABLED=true is set explicitly, so nobody gets called back automatically
// without someone deliberately opting in.
function isEnabled() {
  return process.env.FOLLOWUP_CALLS_ENABLED === 'true';
}

// Finds calls where the caller wanted to book but the call ended without one (see
// /voice/status), waits at least FOLLOWUP_DELAY_MINUTES so we're not immediately
// re-dialing someone who just hung up, and places one outbound call back. Idempotent via
// followup_attempted_at, set right after a successful placeOutboundCall - a call is never
// attempted twice even if the process restarts mid-scan.
export async function scanAndPlaceFollowups(): Promise<number> {
  if (!isTwilioCallingConfigured()) {
    console.warn('[followups] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set - skipping scan');
    return 0;
  }

  const result = await query(
    `SELECT c.id, c.caller_number, b.phone_number AS business_phone_number
     FROM calls c
     JOIN businesses b ON b.id = c.business_id
     WHERE c.needs_followup = true
       AND c.followup_attempted_at IS NULL
       AND c.created_at <= now() - ($1 * interval '1 minute')
       AND c.caller_number IS NOT NULL
       AND b.phone_number IS NOT NULL`,
    [FOLLOWUP_DELAY_MINUTES]
  );

  let placed = 0;
  for (const call of result.rows) {
    try {
      await placeOutboundCall({
        to: call.caller_number,
        from: call.business_phone_number,
        connectUrl: `${PUBLIC_BASE_URL}/voice/followup-connect`,
        statusCallbackUrl: `${PUBLIC_BASE_URL}/voice/status`,
      });
      await query('UPDATE calls SET followup_attempted_at = now() WHERE id = $1', [call.id]);
      placed += 1;
    } catch (err: any) {
      console.error('[followups] failed for call', call.id, err.message);
    }
  }

  return placed;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startFollowupScheduler() {
  if (!isEnabled()) {
    console.log('[followups] FOLLOWUP_CALLS_ENABLED is not "true" - automatic follow-up calls are off');
    return;
  }
  if (timer) return;

  const run = () => {
    scanAndPlaceFollowups()
      .then((count) => {
        if (count > 0) console.log(`[followups] placed ${count} follow-up call(s)`);
      })
      .catch((err) => console.error('[followups] scan failed:', err.message));
  };

  run();
  timer = setInterval(run, FOLLOWUP_POLL_MINUTES * 60 * 1000);
}

export function stopFollowupScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
