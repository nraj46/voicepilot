// VoicePilot agent loop (demo mode — no external LLM key required).
//
// Architecture mirrors a production voice agent:
//   STT transcript -> intent/state machine (the "LLM" in a real deployment)
//   -> tool calls (function calling) -> response composition -> TTS text.
//
// The decision layer is a deterministic intent parser + slot-filling state
// machine so the demo is fully reproducible without an API key. In
// production, swap `handleMessage`'s parsing for an LLM call with these
// same tools exposed as function schemas — the tools, guardrails, trace
// and state handling stay identical.
//
// Guardrails implemented here:
//  - Medical-advice requests are refused and escalated to the front desk.
//  - Emergencies get a 911 note plus front-desk escalation.
//  - Out-of-scope requests are refused politely.
//  - Bookings require an explicit confirmation ("yes") after a read-back.
//  - All PII is redacted from traces before they leave the server.

import {
  formatDateLabel,
  formatTimeLabel,
  getServiceById,
  getServices,
  toISODate,
} from "./store";
import * as tools from "./tools";
import { phoneEnding, redactPII, redactValue } from "./redact";

export interface TraceEntry {
  id: number;
  kind: "tool" | "guardrail";
  name: string;
  args?: unknown;
  result: string;
  latencyMs?: number;
  timestamp: string;
}

export interface SessionMetrics {
  turns: number;
  toolCalls: number;
  avgLatencyMs: number;
}

export interface AgentResponse {
  reply: string;
  traces: TraceEntry[];
  metrics: SessionMetrics;
  state: string;
}

interface PendingBooking {
  serviceId?: string;
  date?: string;
  slotId?: string;
  slotLabel?: string;
  dentistName?: string;
  patientName?: string;
  phone?: string;
}

interface Session {
  stage: "idle" | "collecting" | "confirming";
  pending: PendingBooking;
  offeredSlots: { slotId: string; time: string; label: string; dentistName: string }[];
  lastAppointmentId?: string;
  clarifyCount: number;
  turns: number;
  toolCalls: number;
  totalLatencyMs: number;
}

const globalForSessions = globalThis as unknown as {
  __voicepilotSessions?: Map<string, Session>;
  __voicepilotTraceSeq?: number;
};

function getSession(id: string): Session {
  if (!globalForSessions.__voicepilotSessions) {
    globalForSessions.__voicepilotSessions = new Map();
  }
  let s = globalForSessions.__voicepilotSessions.get(id);
  if (!s) {
    s = {
      stage: "idle",
      pending: {},
      offeredSlots: [],
      clarifyCount: 0,
      turns: 0,
      toolCalls: 0,
      totalLatencyMs: 0,
    };
    globalForSessions.__voicepilotSessions.set(id, s);
  }
  return s;
}

function now(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function runTool(
  s: Session,
  traces: TraceEntry[],
  name: string,
  args: Record<string, unknown>,
  fn: () => tools.ToolOutcome
): tools.ToolOutcome {
  const start = performance.now();
  const outcome = fn();
  const latency = Math.max(0.1, Math.round((performance.now() - start) * 10) / 10);
  s.toolCalls += 1;
  s.totalLatencyMs += latency;
  globalForSessions.__voicepilotTraceSeq = (globalForSessions.__voicepilotTraceSeq ?? 0) + 1;
  traces.push({
    id: globalForSessions.__voicepilotTraceSeq,
    kind: "tool",
    name,
    args: redactValue(args),
    result: redactPII(outcome.summary),
    latencyMs: latency,
    timestamp: now(),
  });
  return outcome;
}

function traceGuardrail(traces: TraceEntry[], name: string, result: string) {
  globalForSessions.__voicepilotTraceSeq = (globalForSessions.__voicepilotTraceSeq ?? 0) + 1;
  traces.push({
    id: globalForSessions.__voicepilotTraceSeq,
    kind: "guardrail",
    name,
    result,
    timestamp: now(),
  });
}

function metricsOf(s: Session): SessionMetrics {
  return {
    turns: s.turns,
    toolCalls: s.toolCalls,
    avgLatencyMs: s.toolCalls ? Math.round((s.totalLatencyMs / s.toolCalls) * 10) / 10 : 0,
  };
}

function respond(s: Session, traces: TraceEntry[], reply: string): AgentResponse {
  return { reply, traces, metrics: metricsOf(s), state: s.stage };
}

// ---------------------------------------------------------------------------
// Extractors (the "understanding" layer — an LLM would do this in production)
// ---------------------------------------------------------------------------

function extractServiceId(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const svc of getServices()) {
    if (svc.keywords.some((k) => lower.includes(k))) return svc.id;
  }
  return undefined;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function extractDate(text: string): string | undefined {
  const lower = text.toLowerCase();
  const today = new Date();
  const isoMatch = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) return isoMatch[0];
  if (/\btoday\b/.test(lower)) return toISODate(today);
  if (/\btomorrow\b/.test(lower)) {
    return toISODate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  }
  const inDays = lower.match(/\bin (\d{1,2}) days?\b/);
  if (inDays) {
    return toISODate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + Number(inDays[1])));
  }
  const monthDay = lower.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );
  if (monthDay) {
    const month = MONTHS[monthDay[1]];
    const day = Number(monthDay[2]);
    let d = new Date(today.getFullYear(), month, day);
    if (d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
      d = new Date(today.getFullYear() + 1, month, day);
    }
    return toISODate(d);
  }
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      const delta = (dow - today.getDay() + 7) % 7;
      const extra = /\bnext\b/.test(lower) && delta === 0 ? 7 : 0;
      return toISODate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta + extra));
    }
  }
  return undefined;
}

/** Returns "HH:MM" 24h, or undefined. */
function extractTime(text: string): string | undefined {
  const lower = text.toLowerCase();
  const ampm = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3] === "pm") h += 12;
    return `${String(h).padStart(2, "0")}:${ampm[2] ?? "00"}`;
  }
  const h24 = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (h24) return `${h24[1].padStart(2, "0")}:${h24[2]}`;
  return undefined;
}

function extractPhone(text: string): string | undefined {
  const m = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/) || text.match(/\b\d{10}\b/);
  if (!m) return undefined;
  const digits = m[0].replace(/\D/g, "");
  return digits.length >= 10 ? m[0].trim() : undefined;
}

const NON_NAME_WORDS =
  /^(yes|no|ok|okay|sure|hi|hello|hey|today|tomorrow|book|booking|appointment|cancel|thanks|thank you)$/i;

function extractName(text: string, awaitingName: boolean): string | undefined {
  const explicit = text.match(/my name is\s+([A-Za-z][A-Za-z .'-]{1,40})/i) || text.match(/this is\s+([A-Za-z][A-Za-z .'-]{1,40})/i);
  const candidate = explicit ? explicit[1] : awaitingName ? text.trim() : undefined;
  if (!candidate) return undefined;
  const cleaned = candidate.replace(/[.!?,]+$/g, "").trim();
  if (!cleaned || NON_NAME_WORDS.test(cleaned)) return undefined;
  if (/\d/.test(cleaned) || cleaned.split(/\s+/).length > 4) return undefined;
  if (/book|appointment|cancel|available|tomorrow|today/i.test(cleaned)) return undefined;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractOrdinal(text: string): number | undefined {
  const lower = text.toLowerCase().trim();
  const words: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 };
  for (const [w, n] of Object.entries(words)) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) return n;
  }
  const numbered = lower.match(/(?:option|number|slot)\s*(\d)/) || lower.match(/^(\d)$/);
  return numbered ? Number(numbered[1]) : undefined;
}

const YES_RE = /^(yes|yeah|yep|sure|ok|okay|confirm|book it|please do|correct|that'?s right|go ahead)\b/i;
const NO_RE = /^(no|nope|cancel|don'?t|never ?mind|wrong|stop)\b/i;

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

const MEDICAL_RE =
  /diagnos|prescri|\bmedicine\b|medication|antibiotic|pain ?killer|what should i take|is (it|this) serious|\bsymptom|medical advice|\bcure\b|infection/i;
const EMERGENCY_RE = /emergency|can'?t breathe|severe pain|unconscious|chest pain|bleeding heavily/i;
const OUT_OF_SCOPE_RE = /flight|hotel|weather|taxi|\buber\b|\blyft\b|pizza|movie|stock price|train ticket|restaurant/i;

const FRONT_DESK = "connecting you to the front desk — a team member will take it from here.";

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function handleMessage(sessionId: string, rawMessage: string): AgentResponse {
  const s = getSession(sessionId);
  s.turns += 1;
  const traces: TraceEntry[] = [];
  const text = rawMessage.trim();
  const lower = text.toLowerCase();

  // --- Guardrail: emergencies & medical advice --------------------------
  if (EMERGENCY_RE.test(lower)) {
    traceGuardrail(traces, "guardrail.emergency", "Escalated to front desk; caller advised to call 911 if urgent");
    return respond(
      s,
      traces,
      `That sounds urgent. If this is a medical emergency, please call 911 right away. For anything else, I can't help with that — ${FRONT_DESK}`
    );
  }
  if (MEDICAL_RE.test(lower)) {
    traceGuardrail(traces, "guardrail.medical_advice", "Refused medical advice; escalated to front desk");
    return respond(
      s,
      traces,
      `I'm an appointment assistant, so I can't give medical advice or diagnose symptoms. I can't help with that — ${FRONT_DESK} If you'd like, I can still book you an appointment to be seen in person.`
    );
  }

  // --- Guardrail: out of scope ------------------------------------------
  if (OUT_OF_SCOPE_RE.test(lower) && !/dental|dentist|cleaning|checkup|whitening|filling|tooth|teeth/i.test(lower)) {
    traceGuardrail(traces, "guardrail.out_of_scope", "Refused out-of-scope request");
    return respond(
      s,
      traces,
      `I can only help with BrightSmile Dental appointments — booking, checking availability, listing services, or cancelling. For anything else, ${FRONT_DESK}`
    );
  }

  // --- Confirmation stage: booking requires an explicit yes --------------
  if (s.stage === "confirming") {
    if (YES_RE.test(lower)) {
      const p = s.pending;
      const outcome = runTool(
        s,
        traces,
        "book_appointment",
        { patient: p.patientName ?? "", phone: p.phone ?? "", service: p.serviceId ?? "", slot: p.slotId ?? "" },
        () =>
          tools.book_appointment({
            patient: p.patientName ?? "",
            phone: p.phone,
            service: p.serviceId ?? "",
            slot: p.slotId ?? "",
          })
      );
      s.stage = "idle";
      s.pending = {};
      s.offeredSlots = [];
      if (outcome.ok && outcome.data) {
        const d = outcome.data as { appointmentId: string; service: string; date: string; time: string; dentist: string };
        s.lastAppointmentId = d.appointmentId;
        return respond(
          s,
          traces,
          `You're booked! Appointment ${d.appointmentId}: ${d.service} on ${formatDateLabel(d.date)} at ${d.time} with ${d.dentist}. We'll text a reminder to your phone ending in ${p.phone ? phoneEnding(p.phone) : "****"}. Anything else I can help with?`
        );
      }
      return respond(s, traces, `I'm sorry — ${outcome.summary}. Let's try a different time; just tell me a day and I'll check what's open.`);
    }
    if (NO_RE.test(lower)) {
      s.stage = "idle";
      s.pending = {};
      s.offeredSlots = [];
      return respond(s, traces, "No problem — I haven't booked anything. Let me know if you'd like a different service or time.");
    }
    return respond(s, traces, "I just need a yes or no — shall I book that appointment?");
  }

  // --- Cancellation -------------------------------------------------------
  if (/\bcancel\b/.test(lower) && /appointment|booking|appt\b/.test(lower)) {
    const idMatch = text.match(/APT-\d+/i);
    const targetId = idMatch ? idMatch[0].toUpperCase() : s.lastAppointmentId;
    if (!targetId) {
      return respond(
        s,
        traces,
        "I can cancel that for you — what's the appointment ID? It looks like APT-1001 and was in your booking confirmation."
      );
    }
    const outcome = runTool(s, traces, "cancel_appointment", { id: targetId }, () =>
      tools.cancel_appointment({ id: targetId })
    );
    if (outcome.ok && s.lastAppointmentId === targetId) s.lastAppointmentId = undefined;
    return respond(
      s,
      traces,
      outcome.ok ? `Done — ${outcome.summary}. The slot is open again. Anything else?` : `${outcome.summary}. Please check the ID and try again.`
    );
  }

  // --- Reschedule: honest hand-off to supported operations ----------------
  if (/reschedule|move my appointment|change my appointment/i.test(lower)) {
    return respond(
      s,
      traces,
      "I can't move an appointment directly, but I can cancel the existing one and book a new time. Give me the appointment ID to cancel, or just tell me the new service and day you'd like."
    );
  }

  // --- Services info -------------------------------------------------------
  if (
    s.stage !== "collecting" &&
    /what services|services do you|treatments|what do you offer|price|cost|how much/i.test(lower)
  ) {
    const outcome = runTool(s, traces, "get_services", {}, () => tools.get_services());
    const data = outcome.data as { services: { name: string; durationMin: number; price: string }[] };
    const list = data.services.map((v) => `${v.name} (${v.durationMin} min, ${v.price})`).join("; ");
    return respond(s, traces, `We offer: ${list}. Would you like to book one of these? Just name the service and a day.`);
  }

  // --- Greeting (only when the message is *just* a greeting) ---------------
  if (s.stage === "idle" && /^(hi|hello|hey|good (morning|afternoon|evening))(\s+there)?[!.,\s]*$/i.test(lower)) {
    return respond(
      s,
      traces,
      "Hello! You've reached BrightSmile Dental. I can book an appointment, check availability, list our services, or cancel a booking. What would you like to do?"
    );
  }

  // --- Booking / availability slot-filling flow -----------------------------
  const wantsBooking =
    s.stage === "collecting" ||
    /book|appointment|schedule|available|availability|slot|dentist|visit/i.test(lower) ||
    extractServiceId(text) !== undefined;

  if (wantsBooking) {
    // Abort mid-collection
    if (s.stage === "collecting" && /^(cancel|never ?mind|forget it|stop)$/i.test(lower.trim())) {
      s.stage = "idle";
      s.pending = {};
      s.offeredSlots = [];
      return respond(s, traces, "No problem, I've discarded that. Anything else I can help with?");
    }
    s.stage = "collecting";
    s.clarifyCount = 0;
    return respond(s, traces, advanceCollection(s, traces, text));
  }

  // --- Unrecognized input: clarify once, then hand off ----------------------
  s.clarifyCount += 1;
  if (s.clarifyCount === 1) {
    return respond(
      s,
      traces,
      "Sorry, I didn't quite catch that. I can book an appointment, check availability, list our services, or cancel a booking — which would you like?"
    );
  }
  s.clarifyCount = 0;
  traceGuardrail(traces, "agent.handoff", "Two unrecognized turns in a row — offered human handoff");
  return respond(
    s,
    traces,
    `I'm having trouble understanding — ${FRONT_DESK} Or, if you'd like to try again, just say something like "book a cleaning tomorrow".`
  );
}

// ---------------------------------------------------------------------------
// Slot-filling: fill what we can from this turn, then advance the dialog.
// ---------------------------------------------------------------------------

function advanceCollection(s: Session, traces: TraceEntry[], text: string): string {
  const p = s.pending;

  // Fill slots opportunistically from the latest message.
  const serviceId = extractServiceId(text);
  if (serviceId && !p.serviceId) p.serviceId = serviceId;

  const date = extractDate(text);
  if (date && date !== p.date) {
    p.date = date;
    p.slotId = undefined;
    p.slotLabel = undefined;
    s.offeredSlots = [];
  }

  const phone = extractPhone(text);
  if (phone && !p.phone) p.phone = phone;

  // Pick a slot from the offered list (by time or by ordinal).
  const time = extractTime(text);
  if (!p.slotId && s.offeredSlots.length > 0) {
    let chosen = time ? s.offeredSlots.find((o) => o.time === time) : undefined;
    if (!chosen) {
      const ord = extractOrdinal(text);
      if (ord && ord >= 1 && ord <= s.offeredSlots.length) chosen = s.offeredSlots[ord - 1];
    }
    if (chosen) {
      p.slotId = chosen.slotId;
      p.slotLabel = chosen.label;
      p.dentistName = chosen.dentistName;
    } else if (time) {
      const openList = s.offeredSlots.map((o, i) => `${i + 1}) ${o.label} with ${o.dentistName}`).join(", ");
      return `${formatTimeLabel(time)} isn't open on ${p.date ? formatDateLabel(p.date) : "that day"}. Open times: ${openList}. Which would you like?`;
    }
  }

  const awaitingName = Boolean(p.slotId && !p.patientName);
  if (awaitingName) {
    const name = extractName(text, true);
    if (name) p.patientName = name;
  } else if (!p.patientName) {
    const name = extractName(text, false);
    if (name) p.patientName = name;
  }

  // Advance: ask for the next missing piece.
  if (!p.serviceId) {
    const names = getServices().map((v) => v.name).join(", ");
    return `Of course — which service would you like? We offer ${names}.`;
  }
  const service = getServiceById(p.serviceId);

  if (!p.date) {
    return `Great, ${service?.name}. What day works for you? We're open Monday to Saturday — you can say "tomorrow" or a date like "November 10".`;
  }

  if (!p.slotId) {
    const outcome = runTool(
      s,
      traces,
      "check_availability",
      { date: p.date, service: service?.name ?? p.serviceId },
      () => tools.check_availability({ date: p.date!, service: p.serviceId })
    );
    const data = outcome.data as {
      available: { slotId: string; time: string; label: string; dentist: string }[];
      nextAvailable: { date: string; slots: { slotId: string; time: string; label: string; dentist: string }[] } | null;
    };
    if (data.available.length === 0) {
      if (data.nextAvailable) {
        p.date = data.nextAvailable.date;
        s.offeredSlots = data.nextAvailable.slots.map((sl) => ({
          slotId: sl.slotId,
          time: sl.time,
          label: sl.label,
          dentistName: sl.dentist,
        }));
        const list = s.offeredSlots.map((o, i) => `${i + 1}) ${o.label} with ${o.dentistName}`).join(", ");
        return `I'm sorry, we're fully booked on the day you asked for. The next day with openings is ${formatDateLabel(p.date)}: ${list}. Say a time or a number to pick one.`;
      }
      p.date = undefined;
      return "We're fully booked for the coming week. Please try another week, or I can connect you to the front desk.";
    }
    s.offeredSlots = data.available.map((sl) => ({
      slotId: sl.slotId,
      time: sl.time,
      label: sl.label,
      dentistName: sl.dentist,
    }));
    // If the caller already named a time in this same turn, take it.
    if (time) {
      const chosen = s.offeredSlots.find((o) => o.time === time);
      if (chosen) {
        p.slotId = chosen.slotId;
        p.slotLabel = chosen.label;
        p.dentistName = chosen.dentistName;
      }
    }
    if (!p.slotId) {
      const list = s.offeredSlots.map((o, i) => `${i + 1}) ${o.label} with ${o.dentistName}`).join(", ");
      return `For ${service?.name} on ${formatDateLabel(p.date)}, open times are: ${list}. Which works for you?`;
    }
  }

  if (!p.patientName) {
    return `${p.slotLabel} on ${formatDateLabel(p.date!)} with ${p.dentistName} — great choice. May I have your full name for the booking?`;
  }

  if (!p.phone) {
    const first = p.patientName.split(/\s+/)[0];
    return `Thanks, ${first}. What's the best phone number for appointment reminders?`;
  }

  // Everything collected — read back and require explicit confirmation.
  s.stage = "confirming";
  const dentist = p.dentistName ?? "";
  return `Just to confirm: ${service?.name} for ${p.patientName} on ${formatDateLabel(p.date!)} at ${p.slotLabel} with ${dentist}. We'll use the phone ending in ${phoneEnding(p.phone)} for reminders. Shall I book it? Say yes to confirm, or no to cancel.`;
}

// (end of agent module)
