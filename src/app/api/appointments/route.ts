import { connection, NextResponse } from "next/server";
import {
  formatDateLabel,
  formatTimeLabel,
  getDentistById,
  getServiceById,
  listAppointments,
} from "@/lib/store";
import { redactPII } from "@/lib/redact";

// GET /api/appointments — dashboard snapshot of the in-memory store.
// Phone numbers are redacted before leaving the server (guardrail).
export async function GET() {
  await connection();
  const appointments = listAppointments().map((a) => ({
    id: a.id,
    patientName: a.patientName,
    phone: a.phone ? redactPII(a.phone) : undefined,
    service: getServiceById(a.serviceId)?.name ?? a.serviceId,
    date: a.date,
    dateLabel: formatDateLabel(a.date),
    timeLabel: formatTimeLabel(a.time),
    dentist: getDentistById(a.dentistId)?.name ?? a.dentistId,
    status: a.status,
    createdVia: a.createdVia,
  }));
  return NextResponse.json({
    appointments,
    totals: {
      booked: appointments.filter((a) => a.status === "booked").length,
      cancelled: appointments.filter((a) => a.status === "cancelled").length,
    },
  });
}
