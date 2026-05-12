# skills — P2

Skill files pentru navigare cascade (coords → ui_tree → ocr → vision).

## Ce conține

- `skill.service.ts` — citire/scriere skill files, auto-learn coords
- `cascade-tap.ts` — CASCADE TAP: coords → ui_tree → ocr → vision
- `cascade-verify.ts` — CASCADE VERIFY: ui_tree_diff → vision
- `first-run-mapping.ts` — mapping complet app la prima rulare
- `templates/` — skill files per platformă (instagram.skill, tiktok.skill)
- `parsers/` — parsers pentru skill file format

## Skill File Format

Fiecare platformă are un fișier `.skill` cu 3 secțiuni:
1. **Button Map** — coordonate + selectori pentru elemente
2. **Navigation Map** — harta ecran → ecran
3. **Flows** — flow-uri de business (nu se modifică automat)

## Element Types

```yaml
fixed:        # nav bar, toolbar — coords stocate, auto-update
contextual:   # butoane pe ecran specific — coords + screen, auto-update
variable:     # feed, liste — NICIODATĂ coords, mereu ui_tree/vision
```

## CASCADE TAP (cum găsim un element) — 4 niveluri

```
NIVEL 1 — Coords din skill (rapid, ~50ms)
  Element fixed/contextual + confidence > 0.85?
  DA → tap coords
  NU → Nivel 2

NIVEL 2 — UI Tree (fiabil, ~200ms)
  Selector din skill există în ui_tree curent?
  DA → extrage coords din ui_tree → tap
  NU → Nivel 3

NIVEL 3 — OCR / ML Kit (mediu, ~1-1.5s)  ← NOU
  Screenshot → ML Kit Text Recognition
  Caută text din element.selector.text sau visual_hint
  DA → bounding box → center coords → tap
  NU → Nivel 4

NIVEL 4 — Vision (flexibil, ~15-20s)
  Screenshot + visual_hint → vision model → coords → tap
```

## CASCADE VERIFY (a mers?)

```
VERIFY 1 — UI Tree diff (rapid)
  UI tree s-a schimbat? Elementul expected există?
  DA → SUCCESS
  NECONCLUDENT → Verify 2

VERIFY 2 — Vision check (robust)
  Screenshot arată ecranul așteptat?
  DA → SUCCESS
  NU → TAP FAILED → retry cu nivel următor
```

## Auto-Learn Coords

Când tap reușește prin Nivel 2 sau 3:
- fixed/contextual: loghează în coordinate_updates, după 3 succese → update skill
- variable: niciodată coords, loghează selector_failure

## DB Tables Used

- `navigation_logs` — loghează fiecare tap (method_used, fallback_chain)
- `coordinate_updates` — coords învățate, pending apply
- `mapping_reports` — rapoarte first-run mapping
