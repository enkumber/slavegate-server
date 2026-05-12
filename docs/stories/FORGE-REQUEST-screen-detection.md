# 🔨 FORGE Request: Screen Detection Cascade

**From:** ATLAS  
**Story:** `STORY-screen-detection-cascade.md`  
**Date:** 2026-03-29  
**Priority:** P1

---

## Task

Provide technical design for Instagram Screen Detection Cascade.

**Story file:** `/docs/stories/STORY-screen-detection-cascade.md`

---

## What FORGE Needs to Deliver

### 1. Module Architecture

- Directory structure for `src/modules/screen-detection/`
- Interface definitions (`types.ts`)
- Service class structure
- Integration points with existing code

### 2. Rules Engine Design

- How to parse rules from skill file YAML
- Marker matching algorithm
- Priority-based evaluation order
- Confidence scoring formula

### 3. Cascade Flow

```
detectScreen(deviceId, platform)
    │
    ├─► L1: UI Tree
    │   └─► if confidence ≥ 0.8 → RETURN
    │
    ├─► L2: OCR
    │   └─► if confidence ≥ 0.8 → RETURN
    │
    └─► L3: VLM
        └─► RETURN (always)
```

Design each level's implementation.

### 4. Skill File Schema

Define the YAML schema for `detection_rules:` section in skill files.

### 5. Migration Plan

How to replace `ensureHomeFeedVLM()` without breaking existing functionality.

---

## Key Questions to Answer

1. **Module location confirmed?** `src/modules/screen-detection/`
2. **Job types needed?** Confirm `ui_tree_dump`, `ocr_full` exist/needed
3. **Caching layer?** In-memory or Redis?
4. **Error handling?** What if all 3 levels fail?
5. **Logging/telemetry?** Schema for detection events

---

## Existing Code References

| File | Relevance |
|------|-----------|
| `orchestrator.ts:420-455` | `ensureHomeFeedVLM()` to replace |
| `skill.cascade.ts` | Existing cascade pattern |
| `parsers/instagram/parser.ts:28-42` | `detectScreen()` basic impl |
| `instagram.skill` | Screen indicators |
| `cascadeCore.ts` | Shared cascade utilities |

---

## Expected Output

FORGE should produce:
1. `DESIGN-screen-detection.md` with full technical spec
2. Interface definitions (can be inline or separate file)
3. Implementation order / phases
4. Risk analysis

---

**Deadline:** Before implementation starts  
**Blocker:** None — ATLAS has provided all requirements
