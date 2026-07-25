import { getDb } from "../../db/client";

export type RequestType =
  | "element_find"
  | "verify_action"
  | "screen_understand"
  | "screen_classification";

export async function resolveVisionPrompt(
  requestType: RequestType,
  actionType: string,
): Promise<string> {
  const keys = [`${requestType}:${actionType.trim()}`, `${requestType}:default`];
  const result = await getDb().query(
    `SELECT entry_key, payload
       FROM runtime_semantic_entries
      WHERE namespace = 'vision_prompt'
        AND lifecycle_state_matches(
          'runtime_semantic_entries'::regclass,
          status,
          '{"dispatchable":true}'::jsonb
        )
        AND platform = '*'
        AND entry_key = ANY($1::text[])
      ORDER BY CASE WHEN entry_key = $2 THEN 0 ELSE 1 END, priority DESC
      LIMIT 1`,
    [keys, keys[0]],
  );
  const prompt = result.rows[0]?.payload?.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error(`No active vision prompt catalog entry for ${requestType}:${actionType}`);
  }
  return prompt;
}
