// Tool layer: the functions the agent can call, mirroring function /
// tool calling in LLM APIs (OpenAI tools, Anthropic tool use, MCP tools).
// Each tool is a plain typed function over the store with a validated,
// JSON-friendly result — in production these would map 1:1 onto SQL
// queries or an MCP server's tool handlers.

import {
  addAppointment,
  cancelAppointmentById,
  findNextAvailableDay,
  getAvailableSlots,
  getDentistById,
  getServiceById,
  getServices,
  getSlot,
  formatDateLabel,
  type Slot,
} from "./store";

export interface ToolOutcome {
  ok: boolean;
  /** Short human-readable summary shown in the trace panel. */
  summary: string;
  data?: unknown;
}

function slotSummary(slot: Slot) {
  const dentist = getDentistById(slot.dentistId);
  return {
    slotId: slot.id,
    date: slot.date,
    time: slot.time, // "HH:MM" 24h — used for matching caller-stated times
    label: slot.label, // "9:00 AM" — used for display/speech
    dentist: dentist ? dentist.name : slot.dentistId,
  };
}

/** get_services() — list the clinic's services with duration and price. */
export function get_services(): ToolOutcome {
  const services = getServices().map((s) => ({
    name: s.name,
    durationMin: s.durationMin,
    price: `$${s.price}`,
  }));
  return {
    ok: true,
    summary: `${services.length} services: ${services.map((s) => s.name).join(", ")}`,
    data: { services },
  };
}

/** check_availability(date, service) — open slots for a day. */
export function check_availability(args: { date: string; service?: string }): ToolOutcome {
  const available = getAvailableSlots(args.date);
  const service = args.service ? getServiceById(args.service) : undefined;
  const serviceNote = service ? ` for ${service.name}` : "";
  if (available.length === 0) {
    const next = findNextAvailableDay(args.date);
    return {
      ok: true,
      summary: `No open slots on ${formatDateLabel(args.date)}${serviceNote}`,
      data: {
        date: args.date,
        available: [],
        nextAvailable: next ? { date: next.date, slots: next.slots.map(slotSummary) } : null,
      },
    };
  }
  return {
    ok: true,
    summary: `${available.length} open slot${available.length === 1 ? "" : "s"} on ${formatDateLabel(args.date)}${serviceNote}: ${available
      .map((s) => s.label)
      .join(", ")}`,
    data: { date: args.date, available: available.map(slotSummary) },
  };
}

/** book_appointment(patient, service, slot) — create the booking. */
export function book_appointment(args: {
  patient: string;
  phone?: string;
  service: string;
  slot: string;
}): ToolOutcome {
  const slot = getSlot(args.slot);
  if (!slot) {
    return { ok: false, summary: `Slot ${args.slot} not found` };
  }
  if (slot.status !== "available") {
    return { ok: false, summary: `Slot ${slot.label} on ${formatDateLabel(slot.date)} is no longer available` };
  }
  const appt = addAppointment({
    patientName: args.patient,
    phone: args.phone,
    serviceId: args.service,
    slotId: args.slot,
  });
  if (!appt) {
    return { ok: false, summary: "Booking failed — slot was taken" };
  }
  const service = getServiceById(appt.serviceId);
  const dentist = getDentistById(appt.dentistId);
  return {
    ok: true,
    summary: `Booked ${appt.id}: ${service?.name ?? appt.serviceId} on ${formatDateLabel(appt.date)} at ${slot.label} with ${dentist?.name ?? appt.dentistId}`,
    data: {
      appointmentId: appt.id,
      patient: appt.patientName,
      service: service?.name ?? appt.serviceId,
      date: appt.date,
      time: slot.label,
      dentist: dentist?.name ?? appt.dentistId,
    },
  };
}

/** cancel_appointment(id) — cancel an existing booking and free the slot. */
export function cancel_appointment(args: { id: string }): ToolOutcome {
  const appt = cancelAppointmentById(args.id);
  if (!appt) {
    return { ok: false, summary: `No active appointment found with id ${args.id}` };
  }
  const service = getServiceById(appt.serviceId);
  return {
    ok: true,
    summary: `Cancelled ${appt.id}: ${service?.name ?? appt.serviceId} on ${formatDateLabel(appt.date)}`,
    data: { appointmentId: appt.id, status: "cancelled" },
  };
}

export const TOOL_NAMES = ["get_services", "check_availability", "book_appointment", "cancel_appointment"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
