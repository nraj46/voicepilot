# VoicePilot — Real-Time AI Voice Agent

A voice agent for a fictional dental clinic, **BrightSmile Dental**, that books
appointments by voice: it understands requests, checks live availability, calls
tools, confirms before booking, and refuses what it shouldn't do — with every
tool call traced on screen.

**Live demo:** https://voicepilot-ten.vercel.app
**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Web Speech API

> **Demo mode — no API key required.** Speech input uses the browser's built-in
> Web Speech API (`SpeechRecognition`), speech output uses `speechSynthesis`,
> and the agent's decision layer is a deterministic intent + slot-filling state
> machine so the whole flow is reproducible. The header badge says "Demo mode"
> in the UI. Production swaps are listed below — the tools, guardrails, trace
> and state handling stay exactly the same.

This is Project 2 from the video *"Build These 3 AI Projects to Get Hired in
2026"* (a real-time AI voice agent that calls tools, checks availability, and
completes tasks, with guardrails and error handling). The video's reference
stack is Python/FastAPI/STT/LLM/SQL; this implementation uses Nagaraju's
portfolio stack (Next.js) with the **same architecture**, and an in-app
in-memory store standing in for the SQL database.

## Architecture — how it maps to the video's design

| Video architecture | VoicePilot implementation |
| --- | --- |
| Speech-to-text (Whisper/Deepgram) | Browser Web Speech API (`SpeechRecognition`) with live interim transcript + typed fallback (`src/app/page.tsx`) |
| LLM agent loop | Server-side agent in `src/lib/agent.ts`: intent parsing → slot-filling state machine → tool selection → response composition, via `POST /api/agent` |
| Tool / function calling | Typed tools in `src/lib/tools.ts`: `get_services()`, `check_availability(date, service)`, `book_appointment(patient, service, slot)`, `cancel_appointment(id)` |
| SQL database | In-memory store in `src/lib/store.ts` — seeded services, dentists, a week of slots, and appointments. Swap these functions for SQL queries and nothing above them changes |
| Text-to-speech | Browser `speechSynthesis` (toggleable) |
| Guardrails | `src/lib/agent.ts` + `src/lib/redact.ts`: medical-advice refusal + front-desk escalation, emergency/911 path, out-of-scope refusal, confirmation-before-booking, PII redaction in traces/logs |
| Error handling | No availability → nearest-day alternatives; unrecognized input → clarify once, then human handoff; taken slot → graceful re-offer |

## Features

1. **Voice conversation UI** — push-to-talk with live interim transcript, agent
   replies spoken aloud, typed fallback, and a graceful notice when
   `SpeechRecognition` is unsupported (e.g. Firefox).
2. **Visible tool calling** — a trace panel shows every tool call with its
   arguments, result summary, and measured latency, plus guardrail events.
3. **Real agent loop** — multi-turn slot filling: the agent remembers the
   chosen service, date, and slot while collecting the patient's name and
   phone, and can complete a booking started in a single sentence
   ("book a cleaning tomorrow at 10 AM").
4. **Safety guardrails**
   - PII (phone/email) is redacted in traces and dashboard output; spoken
     read-backs use only the last 4 digits.
   - Medical-advice and emergency requests are refused and escalated:
     *"I can't help with that — connecting you to the front desk."*
   - Bookings are never executed silently: the agent reads the details back
     and requires an explicit "yes".
5. **Error handling demos** — fully booked day → offers the next day with
   openings; unknown input → one clarification, then a human-handoff offer.
6. **Live dashboard** — the clinic's appointment list updates immediately
   after a voice booking or cancellation, alongside session metrics
   (turns, tool calls, average tool latency).

## Try it

- "I'd like to book a teeth cleaning for tomorrow at 10 AM" → then give your
  name, a phone number, and say **yes** at the confirmation.
- "What services do you offer?"
- "What medicine should I take for a toothache?" → guardrail escalation.
- "Book me a flight to Denver" → out-of-scope refusal.
- "Cancel appointment APT-1001" → frees the slot in the dashboard.

## How to run

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # production build
npm start       # production server
```

No environment variables or API keys are needed.

## API

- `POST /api/agent` — one conversational turn.
  Body: `{ "sessionId": "abc", "message": "book a cleaning tomorrow at 10 AM" }`
  Returns: `{ reply, traces, metrics, state }`.
- `GET /api/appointments` — dashboard snapshot of the store (PII redacted).

## Production mapping (what changes with real services)

- STT: Web Speech API → Whisper / Deepgram streaming transcription.
- Agent: deterministic parser → LLM (GPT/Claude) with the same four tools
  exposed as function/tool schemas; the state machine becomes the
  conversation manager around the model.
- Store: in-memory module → Postgres/SQLite via the same function signatures.
- TTS: `speechSynthesis` → ElevenLabs / OpenAI TTS; transport → WebRTC
  (e.g. LiveKit) or telephony (Twilio) for real phone calls.

## Why this maps to AI-engineer job requirements

- **Voice agents / conversational AI**: full STT → agent → tool → TTS loop.
- **Function/tool calling & agents**: schema-shaped tools, slot filling,
  multi-turn state, confirmation patterns.
- **Guardrails & safety**: PII redaction, scope/medical refusals, escalation
  paths, human handoff — the parts production voice systems are judged on.
- **Observability**: per-call traces with latency and session metrics.
- **Full-stack delivery**: typed API routes, deterministic seeded data,
  graceful degradation when browser capabilities are missing.
