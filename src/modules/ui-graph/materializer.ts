import { getDb } from "../../db/client";
import type { AppMap } from "../app-mapping/schema";
import { projectLegacyAppMap } from "./legacy-adapter";

function parseMap(value: unknown): AppMap | null {
  if (value && typeof value === "object") return value as AppMap;
  if (typeof value === "string") {
    try { return JSON.parse(value) as AppMap; } catch { return null; }
  }
  return null;
}

export interface MaterializationSummary {
  apps: number;
  states: number;
  variants: number;
  selectors: number;
  transitions: number;
  errors: string[];
}

export async function materializeLegacyAppMap(map: AppMap): Promise<Omit<MaterializationSummary, "apps" | "errors">> {
  const projection = projectLegacyAppMap(map);
  const client = await getDb().connect();
  let variantCount = 0;
  let selectorCount = 0;
  let transitionCount = 0;
  try {
    await client.query("BEGIN");
    const stateIds = new Map<string, string>();
    const variantIds = new Map<string, string>();

    // App Maps are authoritative for legacy-projected transitions. Reconcile
    // removed links as well as additions so stale/incorrect promoted edges can
    // never survive a safe map refresh.
    await client.query(
      `DELETE FROM ui_graph_transitions
       WHERE app_id = $1 AND metadata->>'source' = 'legacy_app_map'`,
      [map.appId],
    );

    for (const state of projection.states) {
      const inserted = await client.query(
        `INSERT INTO ui_graph_states (app_id, state_key, name, kind, safety_class, metadata)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (app_id, state_key) DO UPDATE SET
           name=EXCLUDED.name, metadata=ui_graph_states.metadata || EXCLUDED.metadata, active=TRUE, updated_at=NOW()
         RETURNING id`,
        [map.appId, state.key, state.name, state.kind, state.safetyClass, JSON.stringify({ source: "legacy_app_map", appMapVersion: map.version })],
      );
      const canonicalStateId = inserted.rows[0].id as string;
      stateIds.set(state.id, canonicalStateId);
      for (const variant of state.variants) {
        const saved = await client.query(
          `INSERT INTO ui_graph_state_variants
             (state_id, variant_key, signature_hash, required_anchors, optional_anchors, forbidden_anchors,
              app_version_pattern, locale_pattern, device_class, confidence_threshold, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (state_id, variant_key) DO UPDATE SET
             signature_hash=EXCLUDED.signature_hash, required_anchors=EXCLUDED.required_anchors,
             optional_anchors=EXCLUDED.optional_anchors, forbidden_anchors=EXCLUDED.forbidden_anchors,
             app_version_pattern=EXCLUDED.app_version_pattern, device_class=EXCLUDED.device_class,
             confidence_threshold=EXCLUDED.confidence_threshold, active=TRUE, updated_at=NOW()
           RETURNING id`,
          [canonicalStateId, variant.key, variant.signatureHash ?? null, JSON.stringify(variant.requiredAnchors),
            JSON.stringify(variant.optionalAnchors), JSON.stringify(variant.forbiddenAnchors), variant.appVersionPattern ?? null,
            variant.localePattern ?? null, variant.deviceClass ?? null, variant.confidenceThreshold ?? 0.72,
            JSON.stringify({ source: "legacy_app_map", legacyVariantId: variant.id })],
        );
        variantIds.set(variant.id, saved.rows[0].id as string);
        variantCount++;
      }
    }

    for (const selector of projection.selectors) {
      const canonicalStateId = stateIds.get(selector.stateId);
      if (!canonicalStateId) continue;
      const selectorValue = selector.strategy === "normalized_coords"
        ? { x: selector.coords?.x, y: selector.coords?.y }
        : selector.strategy === "structural"
          ? { path: selector.path }
          : { value: selector.value };
      await client.query(
        `INSERT INTO ui_graph_selectors
           (state_id, element_key, strategy, selector, priority, dynamic, confidence, status,
            app_version_pattern, device_class, success_count, last_validated_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'promoted',$8,$9,1,NOW(),$10)
         ON CONFLICT (state_id, element_key, strategy, selector) DO UPDATE SET
           priority=EXCLUDED.priority, confidence=GREATEST(ui_graph_selectors.confidence, EXCLUDED.confidence),
           app_version_pattern=EXCLUDED.app_version_pattern, device_class=EXCLUDED.device_class,
           metadata=ui_graph_selectors.metadata || EXCLUDED.metadata, updated_at=NOW()
         RETURNING id`,
        [canonicalStateId, selector.elementKey, selector.strategy, JSON.stringify(selectorValue), selector.priority,
          selector.dynamic, selector.confidence, selector.appVersionPattern ?? null, selector.deviceClass ?? null,
          JSON.stringify({ source: "legacy_app_map", variantId: selector.variantId ? variantIds.get(selector.variantId) ?? null : null })],
      );
      selectorCount++;
    }

    for (const transition of projection.transitions) {
      const sourceStateId = stateIds.get(transition.sourceStateId);
      const targetStateId = stateIds.get(transition.targetStateId);
      if (!sourceStateId || !targetStateId) continue;
      await client.query(
        `INSERT INTO ui_graph_transitions
           (app_id, transition_key, source_state_id, target_state_id, element_key, action,
            preconditions, postconditions, cost, safety_class, confidence, status, success_count, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'promoted',1,$12)
         ON CONFLICT (app_id, transition_key) DO UPDATE SET
           source_state_id=EXCLUDED.source_state_id, target_state_id=EXCLUDED.target_state_id,
           element_key=EXCLUDED.element_key, action=EXCLUDED.action, confidence=EXCLUDED.confidence,
           metadata=ui_graph_transitions.metadata || EXCLUDED.metadata, updated_at=NOW()`,
        [map.appId, transition.key, sourceStateId, targetStateId, transition.elementKey ?? null,
          JSON.stringify(transition.action), JSON.stringify(transition.preconditions ?? {}), JSON.stringify(transition.postconditions ?? {}),
          transition.cost, transition.safetyClass, transition.confidence, JSON.stringify({ source: "legacy_app_map", appMapVersion: map.version })],
      );
      transitionCount++;
    }

    await client.query("COMMIT");
    return { states: stateIds.size, variants: variantCount, selectors: selectorCount, transitions: transitionCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function materializeAllLegacyAppMaps(): Promise<MaterializationSummary> {
  const rows = await getDb().query(`SELECT app_id, map_data FROM app_maps ORDER BY app_id`);
  const summary: MaterializationSummary = { apps: 0, states: 0, variants: 0, selectors: 0, transitions: 0, errors: [] };
  for (const row of rows.rows) {
    const map = parseMap(row.map_data);
    if (!map) {
      summary.errors.push(`${row.app_id}: invalid map_data`);
      continue;
    }
    try {
      const result = await materializeLegacyAppMap(map);
      summary.apps++;
      summary.states += result.states;
      summary.variants += result.variants;
      summary.selectors += result.selectors;
      summary.transitions += result.transitions;
    } catch (error) {
      summary.errors.push(`${row.app_id}: ${(error as Error).message}`);
    }
  }
  return summary;
}
