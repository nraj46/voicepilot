// In-memory data store for VoicePilot.
//
// This stands in for the SQL database in the reference architecture
// (STT -> LLM agent -> tool calls -> SQL store). All state lives in a
// module-level singleton, seeded deterministically at startup, so the
// demo runs with no database and no API keys. Swap these functions for
// real SQL queries and the agent/tools layers do not change.

export interface Service {
  id: string;
  name: string;
  durationMin: number;
  price: number;
  keywords: string[];
}

export interface Dentist {
  id: string;
  name: string;
  specialty: string;
}

export interface Slot {
  id: string;
  date: string; // yyyy-mm-dd
  time: string; // HH:MM (24h)
  label: string; // "9:00 AM"
  dentistId: string;
  status: "available" | "booked";
  appointmentId?: string;
}

export interface Appointment {
  id: string;
  patientName: string;
  phone?: string;
  serviceId: string;
  date: string;
  time: string;
  dentistId: string;
  status: "booked" | "cancelled";
  createdVia: "seed" | "voice-agent";
}

const SERVICES: Service[] = [
  { id: "cleaning", name: "Teeth Cleaning", durationMin: 30, price: 120, keywords: ["clean", "cleaning"] },
  { id: "checkup", name: "Checkup & Exam", durationMin: 30, price: 80, keywords: ["checkup", "check-up", "check up", "exam"] },
  { id: "whitening", name: "Teeth Whitening", durationMin: 60, price: 250, keywords: ["whiten", "whitening"] },
  { id: "filling", name: "Filling", durationMin: 45, price: 180, keywords: ["filling", "fill", "cavity"] },
];

const DENTISTS: Dentist[] = [
  { id: "dr-chen", name: "Dr. Sarah Chen", specialty: "General Dentistry" },
  { id: "dr-patel", name: "Dr. James Patel", specialty: "Cosmetic Dentistry" },
  { id: "dr-lopez", name: "Dr. Maria Lopez", specialty: "Family Dentistry" },
];

const SLOT_TIMES = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
const SEED_PATIENTS = ["Alex Morgan", "Jamie Lee", "Priya Nair", "Tom Becker", "Sara Kim"];

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDateLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function formatTimeLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

interface Store {
  slots: Slot[];
  appointments: Appointment[];
  nextId: number;
}

function seedStore(): Store {
  const slots: Slot[] = [];
  const appointments: Appointment[] = [];
  let nextId = 1001;
  let seedPatientIdx = 0;

  const today = new Date();
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    if (day.getDay() === 0) continue; // clinic closed on Sundays
    const iso = toISODate(day);
    SLOT_TIMES.forEach((time, tIdx) => {
      const dentist = DENTISTS[(offset + tIdx) % DENTISTS.length];
      // Deterministic "already booked" pattern (~25% of slots).
      const booked = (offset * 3 + tIdx) % 4 === 1;
      const slot: Slot = {
        id: `${iso}-${time.replace(":", "")}`,
        date: iso,
        time,
        label: formatTimeLabel(time),
        dentistId: dentist.id,
        status: booked ? "booked" : "available",
      };
      if (booked) {
        const appt: Appointment = {
          id: `APT-${nextId++}`,
          patientName: SEED_PATIENTS[seedPatientIdx++ % SEED_PATIENTS.length],
          serviceId: SERVICES[(offset + tIdx) % SERVICES.length].id,
          date: iso,
          time,
          dentistId: dentist.id,
          status: "booked",
          createdVia: "seed",
        };
        slot.appointmentId = appt.id;
        appointments.push(appt);
      }
      slots.push(slot);
    });
  }
  return { slots, appointments, nextId };
}

const globalForStore = globalThis as unknown as { __voicepilotStore?: Store };

function getStore(): Store {
  if (!globalForStore.__voicepilotStore) {
    globalForStore.__voicepilotStore = seedStore();
  }
  return globalForStore.__voicepilotStore;
}

export function getServices(): Service[] {
  return SERVICES;
}

export function getDentists(): Dentist[] {
  return DENTISTS;
}

export function getServiceById(id: string): Service | undefined {
  return SERVICES.find((s) => s.id === id);
}

export function getDentistById(id: string): Dentist | undefined {
  return DENTISTS.find((d) => d.id === id);
}

export function getSlotsForDate(date: string): Slot[] {
  return getStore().slots.filter((s) => s.date === date);
}

export function getAvailableSlots(date: string): Slot[] {
  return getSlotsForDate(date).filter((s) => s.status === "available");
}

export function getSlot(slotId: string): Slot | undefined {
  return getStore().slots.find((s) => s.id === slotId);
}

/** Find the next day (after `afterIso`) that has at least one open slot. */
export function findNextAvailableDay(afterIso: string): { date: string; slots: Slot[] } | null {
  const days = [...new Set(getStore().slots.map((s) => s.date))].sort();
  for (const date of days) {
    if (date > afterIso) {
      const slots = getAvailableSlots(date);
      if (slots.length > 0) return { date, slots };
    }
  }
  return null;
}

export function addAppointment(input: {
  patientName: string;
  phone?: string;
  serviceId: string;
  slotId: string;
}): Appointment | null {
  const store = getStore();
  const slot = store.slots.find((s) => s.id === input.slotId);
  if (!slot || slot.status !== "available") return null;
  const appt: Appointment = {
    id: `APT-${store.nextId++}`,
    patientName: input.patientName,
    phone: input.phone,
    serviceId: input.serviceId,
    date: slot.date,
    time: slot.time,
    dentistId: slot.dentistId,
    status: "booked",
    createdVia: "voice-agent",
  };
  slot.status = "booked";
  slot.appointmentId = appt.id;
  store.appointments.push(appt);
  return appt;
}

export function cancelAppointmentById(id: string): Appointment | null {
  const store = getStore();
  const appt = store.appointments.find((a) => a.id.toUpperCase() === id.toUpperCase());
  if (!appt || appt.status === "cancelled") return null;
  appt.status = "cancelled";
  const slot = store.slots.find((s) => s.appointmentId === appt.id);
  if (slot) {
    slot.status = "available";
    delete slot.appointmentId;
  }
  return appt;
}

export function listAppointments(): Appointment[] {
  return [...getStore().appointments].sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
  );
}
