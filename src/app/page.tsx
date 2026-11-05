"use client";

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types mirroring the API responses
// ---------------------------------------------------------------------------

interface TraceEntry {
  id: number;
  kind: "tool" | "guardrail";
  name: string;
  args?: unknown;
  result: string;
  latencyMs?: number;
  timestamp: string;
}

interface Metrics {
  turns: number;
  toolCalls: number;
  avgLatencyMs: number;
}

interface AgentApiResponse {
  reply: string;
  traces: TraceEntry[];
  metrics: Metrics;
  state: string;
}

interface AppointmentRow {
  id: string;
  patientName: string;
  phone?: string;
  service: string;
  dateLabel: string;
  timeLabel: string;
  dentist: string;
  status: "booked" | "cancelled";
  createdVia: "seed" | "voice-agent";
}

interface ChatMessage {
  role: "user" | "agent";
  text: string;
}

// Minimal Web Speech API typings (not in the standard TS DOM lib).
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}

const QUICK_PROMPTS = [
  "I'd like to book a teeth cleaning for tomorrow at 10 AM",
  "What services do you offer?",
  "What medicine should I take for a toothache?",
  "Book me a flight to Denver",
  "Cancel appointment APT-1001",
];

const GREETING =
  "Hello! You've reached BrightSmile Dental. I'm VoicePilot, the clinic's AI receptionist. I can book an appointment, check availability, list our services, or cancel a booking. Tap Talk and speak, or type below.";

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "agent", text: GREETING }]);
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({ turns: 0, toolCalls: 0, avgLatencyMs: 0 });
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [bookedCount, setBookedCount] = useState(0);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [speechSupported, setSpeechSupported] = useState<boolean | null>(null);
  const [speechOn, setSpeechOn] = useState(true);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const tracesRef = useRef<HTMLDivElement>(null);

  // Session id is created client-side after mount (never during render).
  useEffect(() => {
    setSessionId(`sess-${Date.now().toString(36)}`);
    const w = window as unknown as Record<string, unknown>;
    setSpeechSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    refreshAppointments();
  }, []);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, interim]);

  useEffect(() => {
    tracesRef.current?.scrollTo({ top: tracesRef.current.scrollHeight });
  }, [traces]);

  async function refreshAppointments() {
    try {
      const res = await fetch("/api/appointments");
      const data = await res.json();
      setAppointments(data.appointments ?? []);
      setBookedCount(data.totals?.booked ?? 0);
    } catch {
      // dashboard is best-effort in the demo
    }
  }

  function speak(text: string) {
    if (!speechOn || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    window.speechSynthesis.speak(utter);
  }

  async function send(raw: string) {
    const message = raw.trim();
    if (!message || sending || !sessionId) return;
    setSending(true);
    setInterim("");
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message }),
      });
      const data = (await res.json()) as AgentApiResponse;
      if (data.reply) {
        setMessages((m) => [...m, { role: "agent", text: data.reply }]);
        setTraces((t) => [...t, ...(data.traces ?? [])]);
        if (data.metrics) setMetrics(data.metrics);
        speak(data.reply);
      }
    } catch {
      setMessages((m) => [...m, { role: "agent", text: "Connection error — please try again." }]);
    } finally {
      setSending(false);
      refreshAppointments();
    }
  }

  const sendRef = useRef(send);
  sendRef.current = send;

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const w = window as unknown as Record<string, unknown>;
    const Ctor = (w.SpeechRecognition || w.webkitSpeechRecognition) as
      | (new () => SpeechRecognitionLike)
      | undefined;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let interimText = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      setInterim(interimText);
      if (finalText.trim()) {
        setInterim("");
        void sendRef.current(finalText);
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Voice<span className="text-teal-600">Pilot</span>
            </h1>
            <p className="text-sm text-slate-500">AI voice receptionist · BrightSmile Dental</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
              DEMO MODE — no API key needed
            </span>
            <button
              onClick={() => setSpeechOn((v) => !v)}
              className="text-xs font-medium px-2.5 py-1 rounded-full border border-slate-300 bg-white hover:bg-slate-50"
            >
              Agent voice: {speechOn ? "On" : "Off"}
            </button>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 pb-3 text-xs text-slate-500">
          Speech in: browser Web Speech API · Speech out: speechSynthesis · Agent: server-side loop with
          traced tool calls, guardrails and confirmation before booking. In-memory store stands in for SQL.
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4 grid gap-4 lg:grid-cols-5">
        {/* Conversation */}
        <section className="lg:col-span-3 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
          <div ref={messagesRef} className="h-[440px] overflow-y-auto p-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "bg-teal-600 text-white rounded-br-sm"
                      : "bg-teal-50 border border-teal-100 text-slate-800 rounded-bl-sm"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {interim && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2.5 text-sm italic border border-dashed border-teal-300 text-teal-700 bg-white">
                  {interim}…
                </div>
              </div>
            )}
            {sending && (
              <div className="flex justify-start">
                <div className="text-sm text-slate-400 px-2 py-1">VoicePilot is thinking…</div>
              </div>
            )}
          </div>

          {/* Input row */}
          <div className="border-t border-slate-200 p-3">
            <div className="flex items-center gap-2">
              <button
                onClick={toggleMic}
                disabled={speechSupported === false}
                title={speechSupported === false ? "Speech recognition not supported in this browser" : "Push to talk"}
                className={`shrink-0 w-11 h-11 rounded-full text-white text-xs font-bold flex items-center justify-center transition ${
                  listening
                    ? "bg-red-500 animate-pulse"
                    : speechSupported === false
                      ? "bg-slate-300 cursor-not-allowed"
                      : "bg-teal-600 hover:bg-teal-700"
                }`}
              >
                {listening ? "Stop" : "Talk"}
              </button>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void send(input);
                }}
                placeholder={listening ? "Listening…" : "Type a message, or tap Talk and speak…"}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <button
                onClick={() => void send(input)}
                disabled={sending || !input.trim()}
                className="shrink-0 px-4 py-2.5 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 disabled:bg-slate-300"
              >
                Send
              </button>
            </div>
            {speechSupported === false && (
              <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                Voice input is not supported in this browser — the typed chat works fully. For voice,
                try Chrome or Edge (Web Speech API).
              </p>
            )}
            {listening && <p className="mt-2 text-xs text-red-600">Listening… speak now.</p>}
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="text-xs text-slate-400 py-1">Try:</span>
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q}
                  onClick={() => void send(q)}
                  disabled={sending}
                  className="text-xs px-2 py-1 rounded-full border border-slate-200 bg-slate-50 hover:bg-teal-50 hover:border-teal-200 text-slate-600"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Right rail */}
        <div className="lg:col-span-2 space-y-4">
          {/* Metrics */}
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <h2 className="text-sm font-semibold mb-3">Session metrics</h2>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: "Turns", value: metrics.turns },
                { label: "Tool calls", value: metrics.toolCalls },
                { label: "Avg latency", value: `${metrics.avgLatencyMs} ms` },
                { label: "Booked", value: bookedCount },
              ].map((stat) => (
                <div key={stat.label} className="rounded-lg bg-slate-50 border border-slate-100 py-2">
                  <div className="text-lg font-bold text-teal-700">{stat.value}</div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">{stat.label}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Tool-call trace */}
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <h2 className="text-sm font-semibold">Tool-call trace</h2>
            <p className="text-[11px] text-slate-400 mb-2">
              Every tool call and guardrail event from the agent loop. PII (phone, email) is redacted
              automatically before display.
            </p>
            <div ref={tracesRef} className="h-[260px] overflow-y-auto space-y-2 pr-1">
              {traces.length === 0 && (
                <p className="text-xs text-slate-400 font-mono">
                  No calls yet — ask for availability or book an appointment.
                </p>
              )}
              {traces.map((t) => (
                <div
                  key={t.id}
                  className={`rounded-lg border px-2.5 py-2 font-mono text-[11px] leading-relaxed ${
                    t.kind === "guardrail"
                      ? "border-amber-200 bg-amber-50"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${
                        t.kind === "guardrail" ? "bg-amber-200 text-amber-900" : "bg-teal-600 text-white"
                      }`}
                    >
                      {t.kind === "guardrail" ? "GUARDRAIL" : "TOOL"}
                    </span>
                    <span className="font-semibold text-slate-700">{t.name}</span>
                    <span className="text-slate-400">{t.timestamp}</span>
                    {typeof t.latencyMs === "number" && (
                      <span className="ml-auto text-teal-700">{t.latencyMs} ms</span>
                    )}
                  </div>
                  {t.args !== undefined && (
                    <pre className="mt-1 whitespace-pre-wrap break-all text-slate-500">
                      args: {JSON.stringify(t.args)}
                    </pre>
                  )}
                  <div className="mt-0.5 text-slate-600">→ {t.result}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Appointments dashboard */}
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <h2 className="text-sm font-semibold mb-2">
              Clinic appointments <span className="text-slate-400 font-normal">(live store)</span>
            </h2>
            <div className="max-h-[300px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-slate-100">
                    <th className="py-1 pr-2 font-medium">ID</th>
                    <th className="py-1 pr-2 font-medium">Patient</th>
                    <th className="py-1 pr-2 font-medium">Service</th>
                    <th className="py-1 pr-2 font-medium">When</th>
                    <th className="py-1 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {appointments.map((a) => (
                    <tr key={a.id} className="border-b border-slate-50">
                      <td className="py-1.5 pr-2 font-mono text-slate-500">{a.id}</td>
                      <td className="py-1.5 pr-2">
                        {a.patientName}
                        {a.createdVia === "voice-agent" && (
                          <span className="ml-1 px-1 rounded bg-teal-100 text-teal-700 text-[10px] font-semibold">
                            NEW
                          </span>
                        )}
                        {a.phone && <div className="text-slate-400">{a.phone}</div>}
                      </td>
                      <td className="py-1.5 pr-2">{a.service}</td>
                      <td className="py-1.5 pr-2 whitespace-nowrap">
                        {a.dateLabel}, {a.timeLabel}
                        <div className="text-slate-400">{a.dentist}</div>
                      </td>
                      <td className="py-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                            a.status === "booked"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-600 line-through"
                          }`}
                        >
                          {a.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {appointments.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-slate-400">
                        Loading appointments…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>

      <footer className="max-w-7xl mx-auto px-4 pb-6 text-xs text-slate-400">
        VoicePilot is a portfolio demo by Nagaraju Chinthalacheruvu. Demo data lives in memory and resets
        when the server restarts. Production mapping: Web Speech API → Whisper/Deepgram STT, rule-based
        agent → LLM function calling, in-memory store → SQL (see README).
      </footer>
    </div>
  );
}
