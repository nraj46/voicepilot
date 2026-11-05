// PII redaction guardrail.
//
// Everything the agent shows in the tool-call trace or returns to the
// dashboard passes through redactPII(), so phone numbers and email
// addresses are never exposed in logs/traces even though callers dictate
// them during a conversation. The raw value is only used internally by
// the booking tool itself.

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  const visible = user.length > 1 ? user[0] : "";
  return `${visible}***@${domain}`;
}

export function redactPII(text: string): string {
  if (!text) return text;
  let out = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m));
  // Phone numbers: (203) 690-4360, 203-690-4360, 203.690.4360, +1 203 690 4360
  out = out.replace(
    /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    (m) => `***-***-${m.replace(/\D/g, "").slice(-4)}`
  );
  // Bare 10-digit numbers (dictated without separators)
  out = out.replace(/\b\d{10}\b/g, (m) => `***-***-${m.slice(-4)}`);
  return out;
}

/** Redact every string inside a trace args/result payload. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactPII(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

/** Mask a phone number for spoken read-back ("ending in 4360"). */
export function phoneEnding(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "****";
}
