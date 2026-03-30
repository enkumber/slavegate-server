# TASKS: Screen Detection Cascade

**Story:** US-SCREEN-CASCADE  
**Design:** `DESIGN-screen-detection.md`  
**Date:** 2026-03-29

---

## Summary

Design-ul tehnic este complet. Screen Detection Cascade implementează detecție pe 3 niveluri (UI Tree → OCR → VLM) pentru a reduce costurile VLM cu 80%+.

---

## Tasks pentru VOLT (Backend TypeScript)

### Priority 1 — Core Module

| Task | Description | Time | Depends On |
|------|-------------|------|------------|
| **V-SD-01** | Create `src/modules/screen-detection/types.ts` — interfaces pentru `ScreenId`, `DetectedScreen`, `ScreenRule`, `UiMarker`, etc. | 1h | — |
| **V-SD-02** | Implement `rules/rule-engine.ts` — YAML parser pentru `detection_rules:` din skill file + generic matcher | 2h | V-SD-01 |
| **V-SD-03** | Implement `detectors/ui-tree.detector.ts` — L1 detection din A11y dump | 2h | V-SD-01, V-SD-02 |
| **V-SD-04** | Implement `detectors/ocr.detector.ts` — L2 detection din ML Kit OCR result | 1.5h | V-SD-01, V-SD-02 |
| **V-SD-05** | Implement `detectors/vlm.detector.ts` — L3 detection via `visionService` | 1h | V-SD-01 |

### Priority 2 — Integration

| Task | Description | Time | Depends On |
|------|-------------|------|------------|
| **V-SD-06** | Implement `screen-detection.service.ts` — main cascade logic, cache, `detectScreen()`, `ensureScreen()` | 2h | V-SD-03, V-SD-04, V-SD-05 |
| **V-SD-07** | Add `detection_rules:` section to `instagram.skill` — all 20+ screens cu markers | 1.5h | V-SD-02 |
| **V-SD-08** | Create DB migration pentru `screen_detection_logs` table | 0.5h | — |
| **V-SD-09** | Replace `ensureHomeFeedVLM()` în `orchestrator.ts` cu `screenDetectionService.detectScreen()` | 1h | V-SD-06 |

### Priority 3 — Testing

| Task | Description | Time | Depends On |
|------|-------------|------|------------|
| **V-SD-10** | Unit tests: rule engine marker matching, ui-tree detector, ocr detector | 2h | V-SD-03, V-SD-04 |

**Total VOLT: ~14h**

---

## Tasks pentru SPARK (Android Agent Kotlin)

| Task | Description | Time | Depends On |
|------|-------------|------|------------|
| **S-SD-01** | Implement `ocr_full` job handler — ML Kit full-screen OCR, return `{ blocks: [...], fullText: "..." }` | 3h | — |
| **S-SD-02** | Optimize `ui_tree_dump` — return JSON format (nu XML), include `contentDescription`, `className`, `text` pentru toate nodurile | 1h | — |
| **S-SD-03** | Add `ocr_full` la shared protocol definitions (`JobType`) | 0.5h | — |

**Total SPARK: ~4.5h**

---

## Critical Path

```
V-SD-01 (types)
    │
    ├─► V-SD-02 (rule engine) ─► V-SD-07 (skill file rules)
    │       │
    │       ├─► V-SD-03 (L1 ui-tree) ─┐
    │       │                         │
    │       ├─► V-SD-04 (L2 ocr) ─────┼─► V-SD-06 (service) ─► V-SD-09 (orchestrator)
    │       │                         │
    └─► V-SD-05 (L3 vlm) ─────────────┘

S-SD-01 (ocr_full) ─► V-SD-04 (needs job to test)
```

**Recommended order:**
1. VOLT: V-SD-01 → V-SD-02 → V-SD-03 (L1 funcțional)
2. SPARK: S-SD-01 (în paralel)
3. VOLT: V-SD-04, V-SD-05 → V-SD-06 → V-SD-09

---

## Feature Flag

```env
# .env
SCREEN_DETECTION_CASCADE_ENABLED=true
```

Dacă `false`, orchestrator folosește `ensureHomeFeedVLM()` original (VLM-only).

---

## Files to Create

```
src/modules/screen-detection/
├── index.ts
├── types.ts
├── screen-detection.service.ts
├── rules/
│   ├── index.ts
│   └── rule-engine.ts
├── detectors/
│   ├── ui-tree.detector.ts
│   ├── ocr.detector.ts
│   └── vlm.detector.ts
└── __tests__/
    ├── rule-engine.test.ts
    └── ui-tree.detector.test.ts
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/modules/skills/templates/instagram.skill` | Add `detection_rules:` section (~150 lines) |
| `src/modules/agents/orchestrator.ts` | Replace `ensureHomeFeedVLM()` implementation |
| `src/modules/dispatcher/dispatcher.service.ts` | Add `ocr_full` to `ALLOWED_JOB_TYPES` |
| `shared/protocol/messages.ts` | Add `ocr_full` to `JobType` |

---

## Routing Decision

| Agents | Tasks |
|--------|-------|
| **VOLT** | V-SD-01 through V-SD-10 |
| **SPARK** | S-SD-01 through S-SD-03 |

**VOLT starts immediately.** SPARK can work în paralel pe S-SD-01.

---

## Success Criteria

- [ ] L1 detectează HOME_FEED, REELS_FULLSCREEN, PROFILE_* cu 95%+ accuracy
- [ ] L2 detectează ecrane cu text distinctiv (ACTION_BLOCKED, etc.)
- [ ] VLM calls scad cu 80%+ în primele 48h
- [ ] No regressions în workflow success rate
- [ ] Latency medie <400ms pentru L1/L2 path
