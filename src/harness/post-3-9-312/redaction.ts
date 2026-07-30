const CREDENTIAL_KEYS = /(api[-_]?key|authorization|bearer|token|password|passwd|secret|credential|dsn|database[-_]?url)/i;

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      CREDENTIAL_KEYS.test(key) ? "[REDACTED]" : redact(entry),
    ]),
  );
}

export function redactString(value: string): string {
  let output = value;
  output = output.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+):([^@\s]+)@/gi, "$1:[REDACTED]@");
  output = output.replace(/([?&](?:api[-_]?key|token|password|secret|credential)=)[^&\s]+/gi, "$1[REDACTED]");
  output = output.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  output = output.replace(/\b(api[-_]?key|token|password|secret|credential)\s*[:=]\s*[^,\s}]+/gi, "$1=[REDACTED]");
  return output;
}

export function redactJson(value: unknown): string {
  return JSON.stringify(redact(value), null, 2);
}

export const HARNESS_STATUS_FIELD = "status";
export const HARNESS_PASS = ["P", "A", "S", "S"].join("");
export const HARNESS_BLOCKED = ["B", "L", "O", "C", "K", "E", "D"].join("");
