import { NextRequest, NextResponse } from "next/server";
import { handleMessage } from "@/lib/agent";

// POST /api/agent — one conversational turn.
// Body: { sessionId: string, message: string }
// Returns: { reply, traces, metrics, state } — reply is the text the
// client speaks with speechSynthesis; traces are the (PII-redacted)
// tool calls and guardrail events from this turn.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { sessionId?: unknown; message?: unknown }
    | null;

  const sessionId =
    typeof body?.sessionId === "string" && body.sessionId.trim()
      ? body.sessionId
      : "default-session";
  const message = typeof body?.message === "string" ? body.message : "";

  if (!message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const result = handleMessage(sessionId, message);
  return NextResponse.json(result);
}
