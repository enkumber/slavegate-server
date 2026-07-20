import { getDb } from "../../db/client";

export type JobExecutionEventSource = "dispatcher" | "direct_ws" | "workflow_executor";

export interface RecordJobExecutionEventInput {
  jobId: string;
  deviceId: string;
  workflowId?: string | null;
  source: JobExecutionEventSource;
  eventType: string;
  details?: Record<string, unknown>;
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/param|payload|output|token|password|credential|secret|text/i.test(key)) continue;
    if (typeof value === "string") {
      safe[key] = value
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
        .replace(/\b(token|api[_ -]?key|secret|password|parola)\s*[:=]?\s*\S+/gi, "$1 [redacted]")
        .slice(0, 500);
    }
    else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
  }
  return safe;
}

export async function recordJobExecutionEvent(input: RecordJobExecutionEventInput): Promise<void> {
  await getDb().query(
    `INSERT INTO job_execution_events
       (job_id, device_id, workflow_id, source, event_type, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.jobId,
      input.deviceId,
      input.workflowId ?? null,
      input.source,
      input.eventType,
      JSON.stringify(sanitizeDetails(input.details)),
    ],
  );
}

export function recordJobExecutionEventDetached(input: RecordJobExecutionEventInput): void {
  void recordJobExecutionEvent(input).catch((err) => {
    console.error(
      `[job-events] failed to persist ${input.eventType} for ${input.jobId.slice(0, 8)}:`,
      (err as Error).message,
    );
  });
}

export async function listJobExecutionEvents(jobId: string): Promise<Record<string, unknown>[]> {
  const result = await getDb().query(
    `SELECT id, job_id, device_id, workflow_id, source, event_type, details, created_at
     FROM job_execution_events
     WHERE job_id = $1
     ORDER BY created_at ASC, id ASC`,
    [jobId],
  );
  return result.rows;
}
