# skill-updater — P4

Self-healing. Actualizează selectori și structură în skill files când UI-ul se schimbă.

## Definiție

```yaml
agent: skill_updater
tip: Spawned
ierarhie: Kraken
trigger: Kraken verifică skill_update_jobs în DB → găsește status='pending' → spawn
face_exit: da, după procesare
```

## Ce face vs Ce NU face

```
SKILL UPDATER face:                   HYDRA face (P2):
─────────────────                     ────────────────
• Actualizează selector               • Actualizează coords (x, y)
• Actualizează visual_hint            • Doar fixed/contextual
• Adaugă/elimină elemente             • Direct, în timp real
• Proces complex (gather→patch)       • Rapid, după 3 eșecuri
• Asincron, triggerat de Ops Monitor  • La fiecare tap
• Scrie skill_patches în DB           • Scrie coordinate_updates în DB
```

**Nu se suprapun.** Hydra rezolvă probleme de coordonate. Skill Updater rezolvă probleme de selectori/structură.

## Proces

```
1. GATHER   — citește failure_data din job + ui_tree dumps din logs
2. ANALYZE  — toate pe aceeași app_version? vision consistent?
3. INSPECT  — parsează ui_tree, caută elementul
4. GENERATE — determină selector nou
5. APPLY    — confidence >= 0.85 → auto-apply + backup
6. SCRIE    — job.status = 'completed' | 'failed' + skill_patches
7. VERIFY   — monitorizează 2h, rollback dacă fail rate crește
```

## Auto-Update Rules

```yaml
high_confidence:                      # auto-apply
  min_occurrences: 20
  min_vision_confidence: 0.85
  same_app_version: true

medium_confidence:                    # pending, notify Dan
  min_occurrences: 10
  min_vision_confidence: 0.75

navigation_map_changes:               # manual review always
  auto_apply: false
  action: log + notify Dan

safeguards:
  max_auto_updates_per_day: 3
  protected_files: ["/skills/primitives/*"]
  auto_rollback: true
  monitoring_period: 2h
```

## DB Tables

- Reads: `skill_update_jobs` (pending)
- Writes: `skill_update_jobs` (status), `skill_patches`
