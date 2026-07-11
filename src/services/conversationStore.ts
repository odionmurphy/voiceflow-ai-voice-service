// In-memory conversation state, keyed by Twilio CallSid.
// This is fine for a single-instance MVP. If this service ever runs on
// multiple instances/processes, swap this for Redis (same key shape works).

export type ConversationTurn = { role: 'assistant' | 'caller'; text: string };

export interface ConversationState {
  callSid: string;
  businessId: string;
  callerNumber: string;
  businessName: string;
  turns: ConversationTurn[];
  intent: 'book' | 'reschedule' | 'cancel' | 'faq' | 'other';
  resultedInAppointmentId: string | null;
  startedAt: number;
  // 'outbound' = this call was placed by us (see jobs/followups.ts), not received. Used
  // to skip re-flagging a follow-up call for yet another follow-up if it also ends
  // without a booking.
  direction: 'inbound' | 'outbound';
}

const conversations = new Map<string, ConversationState>();

export function createConversation(state: ConversationState) {
  conversations.set(state.callSid, state);
}

export function getConversation(callSid: string): ConversationState | undefined {
  return conversations.get(callSid);
}

export function updateConversation(callSid: string, patch: Partial<ConversationState>) {
  const existing = conversations.get(callSid);
  if (!existing) return;
  conversations.set(callSid, { ...existing, ...patch });
}

export function deleteConversation(callSid: string) {
  conversations.delete(callSid);
}
