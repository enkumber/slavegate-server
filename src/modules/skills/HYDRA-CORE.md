# HYDRA-CORE.md — Reguli Universale Navigare Telefon

**Versiune:** 1.1.0
**Actualizat:** 2026-03-16

Acest document conține regulile OBLIGATORII pentru orice sesiune Hydra, indiferent de aplicație sau task.

---

## ⛔ INTERDICȚII ABSOLUTE

### 0. NU folosi /api/jobs cu type: "tap" NICIODATĂ!
```
❌ INTERZIS TOTAL:
POST /api/jobs {"type": "tap", "params": {"x": 270, "y": 210}}
→ Coordonatele VLM sunt în spațiul screenshot-ului (scalat)
→ Tap-ul se execută pe ecranul real (rezoluție diferită)
→ REZULTAT: tap în locul greșit, 100% eșec

✅ OBLIGATORIU — cascade-tap pentru ORICE tap:
POST /api/hydra/cascade-tap {"deviceId": "...", "platform": "instagram", "elementName": "nav.search"}
POST /api/hydra/cascade-tap {"deviceId": "...", "text": "timesbrasov.ro"}

Cascade-tap (4 niveluri):
- L1: Folosește learned_coords (coordonate corecte, normalizate) — ~50ms
- L2: Fallback la ui_tree/a11y (bounds exacte în pixeli reali) — ~200ms
- L3: Fallback la OCR/ML Kit (text detection pe ecran) — ~1.5s [NOU]
- L4: Fallback la VLM (analiză vizuală completă) — ~20s
- NU AI VOIE să faci tap direct, punct.
```

### 1. NU calcula coordonate manual
```
❌ GREȘIT: Analizez screenshot → calculez coords → tap direct
✅ CORECT: cascade-tap "element_name" → sistemul folosește coords învățate
```

### 2. NU folosi `image` tool direct pentru analiză
```
❌ GREȘIT: image("/path/screen.jpg", "ce văd pe ecran?")
   → Imaginea rămâne în context → overflow tokens

✅ CORECT: /api/hydra/vlm/analyze 
   → Rezultat text, imaginea NU rămâne în context
```

### 3. NU ignora verificările post-acțiune
```
❌ GREȘIT: tap → tap → tap → sper că a mers
✅ CORECT: tap → verify → tap → verify
```

### 4. NU folosi VLM pentru verificare ecran/app curent!
```
❌ GREȘIT (lent, 15-20s):
analyze-screen "E Instagram deschis? Ce ecran văd?"
→ Screenshot → VLM → aștept răspuns

✅ CORECT (rapid, <1s):
POST /api/jobs {"type": "get_foreground_app"}
→ Răspunde: "com.instagram.android"

POST /api/jobs {"type": "ui_tree_dump"}
→ Caută elemente specifice ecranului (nav bar, titlu, etc.)

VLM DOAR pentru:
- Analiză vizuală reală (conținut poze, text în imagini)
- Interpretare context (e profil de femeie? pare spam?)
- Când ui_tree NU are informația necesară
```

---

## 📋 REGULI OBLIGATORII

### REGULA 0: Device Ready (la început de sesiune)

**Înainte de orice altceva, pregătește device-ul:**

```
1. get_screen_state → verifică stare ecran
2. Dacă OFF → screen_wake
3. Dacă LOCKED → unlock (farm devices fără PIN)
4. open_app TARGET_APP (din core_integration.package)
5. Wait 3s pentru încărcare app
6. analyze-screen: "Ce app e deschisă? Ce ecran? JSON: {app: string, screen: string}"
7. Dacă NU e pe ecranul așteptat (ex: home_feed):
   - cascade-tap "nav.home" (sau recovery_anchor din skill)
   - Wait 2s
   - Re-verify cu analyze-screen
8. ABIA APOI continuă cu task-ul
```

**IMPORTANT:** Instagram se redeschide pe ULTIMUL ecran vizitat (Reels, DM, etc.)
Întotdeauna resetează la home înainte de navigare!

**La reluare după pauză lungă:** repetă REGULA 0.

---

### REGULA 1: Verificare Ecran (verify-tap)

**După ORICE tap, verifică folosind endpoint-ul dedicat:**

```bash
curl -X POST "$API_URL/api/hydra/verify-tap" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "UUID",
    "platform": "instagram",
    "expectedScreen": "followers_list"
  }'
```

**Ce face verify-tap:**
1. UI tree dump → caută indicatori ecran
2. Dacă nu găsește → VLM fallback
3. Returnează `{ success: true/false, screen: "detected_screen" }`

**Dacă app greșită:**
1. `press_key "back"`
2. Așteaptă 2s
3. Reverify
4. Repetă max 3×
5. Dacă tot greșit → recovery (REGULA 5)

---

### REGULA 2: Overlay/Dialog Handling

**Dacă după ui_tree_dump vezi element neașteptat în prim-plan:**

**Detectare:**
- Dialog/popup acoperă ecranul așteptat
- Butoane precum "Allow", "Deny", "Not Now", "OK", "Cancel", "Update"

**Acțiune:**
1. **Permission necesară pentru task** → tap "Allow"
2. **Permission ne-necesară** → tap "Deny" + log warning
3. **Update dialog** → tap "Later" / "Not now" / "Skip"
4. **Rate/Review popup** → tap "Not now" / "X"
5. **Ad overlay** → caută buton Close/X → tap
6. **Orice altceva** → tap "Cancel" / "X" / press_key "back"

**După dismiss:**
- ui_tree_dump din nou
- Continuă flow-ul normal

---

### REGULA 3: Flow Execution

**Când execuți orice flow din skill, aplică automat:**

```
1. ÎNAINTE de primul pas: verify-tap (ești pe ecranul corect?)
2. DUPĂ fiecare tap: verify-tap (încă în app?)
3. DUPĂ fiecare 5 acțiuni: checkpoint_save
4. LA ORICE eroare: recovery (REGULA 5)
```

**Flows din skill rămân simple — CORE le "învelește" cu safety.**

---

### REGULA 4: Ecrane Critice — Comportament Special

#### 🚫 `action_blocked` (Rate Limit Instagram)

**Când detectezi ecran `action_blocked`:**
```
1. STOP imediat toate acțiunile
2. Salvează checkpoint cu progresul actual
3. Creează job nou cu task-urile RĂMASE
4. Programează job-ul pentru +1-2 ore
5. Închide sesiunea curentă graceful
6. Raportează la Kraken status
```

**NU încerca să continui. NU apăsa OK și continuă.**

#### 🔐 `login` (Sesiune Expirată)

**Când detectezi ecran `login`:**
```
1. STOP imediat
2. Salvează checkpoint
3. Raportează URGENT la Kraken: "Sesiune expirată"
4. Kraken notifică Dan pe Telegram INSTANT
5. Job-ul rămâne în PAUZĂ până la re-login manual
```

**Mesaj către Dan:**
```
⚠️ LOGIN NECESAR

Device: [device_name]
Cont: [@username]
Motiv: Sesiune expirată

Acțiune: Re-login manual necesar
```

---

### REGULA 5: Recovery Logic

**Când ești într-o stare necunoscută:**

```
1. ui_tree_dump → identifică app și ecran
2. Dacă app greșită:
   - press_key "back" × 3
   - Dacă tot greșit: press_key "home"
   - open_app TARGET_APP
   
3. Dacă app corectă dar ecran necunoscut:
   - cascade-tap "nav.home" (reset la stare cunoscută)
   - Reia flow de la început
   
4. Dacă nimic nu merge:
   - Salvează checkpoint
   - STOP și raportează cu screenshot
```

---

### REGULA 6: Ierarhie Instrumente

**Pentru a VEDEA ce e pe ecran:**
```
1. ui_tree_dump (PREFERAT — 0 tokens imagini, ~10s)
2. /api/hydra/vlm/analyze (când ui_tree insuficient — ~20s)
3. screenshot + image tool (DOAR în ultimă instanță)
```

**Pentru a NAVIGA:**
```
1. cascade-tap "element" (PREFERAT — coords învățate, ~50ms)
2. ui_tree/a11y fallback (auto în cascade, bounds exacte, ~200ms)
3. OCR/ML Kit fallback (auto în cascade, text detection, ~1.5s) [NOU]
4. VLM fallback (auto în cascade, analiză vizuală, ~20s)
5. NICIODATĂ tap pe coords calculate/ghicite manual
```

**Pentru DECIZII complexe (e femeie? e profil estetic?):**
```
1. /api/hydra/analyze-screen → UN SINGUR CALL!
   {"deviceId": "...", "task": "E femeie? JSON: {is_female: bool}"}
2. Parsează răspunsul analysis din response
```

---

### REGULA 7: Checkpoints Obligatorii

**Salvează checkpoint după:**
- Fiecare profil procesat complet
- Fiecare 5 acțiuni (follow/like/comment)
- Înainte de scroll în listă nouă
- Când schimbi "fază" în flow
- ÎNAINTE de orice STOP

**Format checkpoint:**
```json
{
  "schemaVersion": "1.0",
  "sessionId": "hydra-session-xyz",
  "taskId": "UUID",
  "deviceId": "device-uuid",
  "phase": "processing_followers",
  "state": {
    "follows_done": ["@user1", "@user2"],
    "likes_done": 5,
    "comments_done": [{"user": "@user1", "text": "Ce vibe!"}],
    "profiles_visited": ["@user1", "@user2", "@user3"],
    "current_screen": "followers_list",
    "scroll_position": 3  // număr de swipe-uri de la top; la restore: execută N × swipe
  },
  "vlm_calls_this_hour": 5,
  "savedAt": "2026-03-16T07:00:00Z"
}
```

**Endpoint:**
```bash
POST $API_URL/api/hydra/checkpoint/save
GET  $API_URL/api/hydra/checkpoint/load?taskId=X&deviceId=Y
```

---

### REGULA 8: State Tracking

**ÎNTOTDEAUNA menține în memorie:**

```markdown
## STATE CURENT
- follows_done: [@user1, @user2]
- likes_done: 5
- comments_done: [{"@user1": "text"}]
- profiles_visited: [@user1, @user2, @user3]
- current_app: com.instagram.android
- current_screen: followers_list
```

**Înainte de orice acțiune, verifică:**
- "Am mai dat follow la acest user?" → skip
- "Am mai comentat la acest post?" → skip
- "Am vizitat deja acest profil?" → skip

---

### REGULA 9: VLM Monitoring

**Kraken monitorizează VLM calls per device/oră.**

Hydra NU se oprește la nicio limită — continuă normal.
Kraken alertează Dan la praguri: 15, 20, 30 calls/oră.

**Hydra contorizează intern (pentru raportare):**
```
vlm_calls_this_hour: 15
last_vlm_reset: 2026-03-16T05:00:00Z
```

**Best practice (nu obligatoriu):**
- Preferă ui_tree_dump când e suficient
- VLM doar pentru decizii vizuale complexe

---

## 🔧 API REFERENCE

### Jobs Endpoint
```bash
POST $API_URL/api/jobs
{
  "deviceId": "UUID",
  "type": "tap|swipe|type_text|screenshot|ui_tree_dump|press_key|open_app|close_app",
  "params": {...}
}
```

### Cascade-Tap
```bash
# Mod 1: Element predefinit (learned_coords → ui_tree → VLM)
POST $API_URL/api/hydra/cascade-tap
{
  "deviceId": "UUID",
  "platform": "instagram",
  "elementName": "nav.search|profile.follow|..."
}

# Mod 2: Text dinamic (ui_tree only, NU salvează coords)
# Folosește pentru elemente specifice contextului (username-uri, rezultate căutare)
POST $API_URL/api/hydra/cascade-tap
{
  "deviceId": "UUID",
  "text": "timesbrasov.ro"
}
# → Caută în ui_tree element cu text → tap pe centrul lui

# ✅ CU VERIFICARE (RECOMANDAT!)
# Adaugă "verify" pentru a confirma că ecranul s-a schimbat după tap
POST $API_URL/api/hydra/cascade-tap
{
  "deviceId": "UUID",
  "platform": "instagram",
  "elementName": "nav.search",
  "verify": "search_screen",      # ecranul așteptat după tap
  "verifyTimeout": 2000           # ms de așteptat înainte de verificare (default: 2000)
}

# Răspuns cu verificare:
{
  "ok": true,
  "success": true,           # TRUE doar dacă TAP + VERIFY au reușit
  "method_used": "coords",
  "verified": true,          # rezultatul verificării
  "verifyError": null        # sau mesaj de eroare
}
```

### ⚠️ FOLOSEȘTE ÎNTOTDEAUNA verify!
```
❌ GREȘIT: cascade-tap fără verify → nu știi dacă a funcționat
✅ CORECT: cascade-tap cu verify → confirmare că ecranul s-a schimbat
```

### Verify-Tap (verificare ecran)
```bash
POST $API_URL/api/hydra/verify-tap
{
  "deviceId": "UUID",
  "platform": "instagram",
  "expectedScreen": "home_feed|followers_list|other_profile|..."
}
# Returnează: { success: true/false, screen: "detected_screen" }
```

### ANALYZE-SCREEN — VLM într-un singur call (RECOMANDAT!)

**FOLOSEȘTE ASTA pentru orice analiză vizuală!**

```bash
curl -X POST "$API_URL/api/hydra/analyze-screen" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "UUID",
    "task": "E femeie? Profil public? JSON: {is_female: bool, is_public: bool}"
  }'

# Răspuns: {"ok":true,"analysis":{"is_female":true,"is_public":true},"screenWidth":1080,"screenHeight":2160}
```

**Ce face:**
1. Screenshot intern (nu returnează base64)
2. Trimite la VLM via OpenClaw
3. Returnează DOAR JSON curat

**ZERO imagini în contextul Hydra!**

### ⚠️ REGULA COORDONATE VLM — NORMALIZARE OBLIGATORIE!

**Când ceri coordonate de la VLM, ÎNTOTDEAUNA cere NORMALIZATE (0.0-1.0)!**

```
❌ GREȘIT (pixeli):
"Unde e butonul? JSON: {x: number, y: number}"
→ VLM răspunde: {x: 270, y: 207} în spațiul screenshot-ului scalat
→ Tap la 270,207 pe ecran 1080x2160 = GREȘIT!

✅ CORECT (normalizat):
"Unde e butonul? Coordonate NORMALIZATE 0.0-1.0 (0,0=stânga-sus, 1,1=dreapta-jos). JSON: {x: 0.0-1.0, y: 0.0-1.0}"
→ VLM răspunde: {x: 0.25, y: 0.10}
→ Tap la (0.25 × screenWidth, 0.10 × screenHeight) = CORECT!
```

**Conversie pentru tap:**
```python
real_x = normalized_x * screenWidth   # 0.25 * 1080 = 270
real_y = normalized_y * screenHeight  # 0.10 * 2160 = 216
```

**De ce:** Screenshot-ul poate fi scalat (ex: 540x1080), dar ecranul real e 1080x2160. Normalizarea elimină problema.

### Screenshot To File (doar dacă ai nevoie de fișier)

```bash
curl -X POST "$API_URL/api/hydra/screenshot-to-file" \
  -H "X-API-Key: $API_KEY" \
  -d '{"deviceId": "UUID", "filePath": "/tmp/screen.jpg"}'
# Răspuns: {"ok":true,"path":"/tmp/screen.jpg","width":1080,"height":2160}
```

### ⛔ NU folosi direct
- `{"type": "screenshot"}` — umple contextul cu base64
- `image` tool direct — același lucru
- `sessions_spawn` pentru VLM — folosește `analyze-screen` în loc

### Checkpoint Save/Load
```bash
POST $API_URL/api/hydra/checkpoint/save
GET  $API_URL/api/hydra/checkpoint/load?taskId=X&deviceId=Y
```

---

## 📊 METRICI SUCCES

O sesiune e considerată **sănătoasă** dacă:
- ✅ >90% din timp în app țintă
- ✅ Checkpoints salvate la fiecare 5 acțiuni
- ✅ Zero "pierdut în app greșită" >30s

---

## 🚨 CÂND SĂ TE OPREȘTI

**STOP IMEDIAT și raportează dacă:**
1. Detectezi `action_blocked` → amână jobs (REGULA 4)
2. Detectezi `login` → notifică Dan (REGULA 4)
3. App crash-uiește repetat
4. Device unresponsive >30s
5. >5 încercări consecutive eșuate pentru aceeași acțiune
6. Context overflow (erori API despre tokens)

**Format raport STOP:**
```
⛔ STOP: [motiv]
Ultima acțiune reușită: [acțiune]
Checkpoint salvat: DA/NU
Jobs amânate: DA (pentru +Xh) / NU
Recomandare: [ce să facă utilizatorul]
```

---

## 🏁 FINALIZARE SESIUNE

**La finalul oricărui job (succes sau stop):**

```
1. Salvează checkpoint final
2. close_app TARGET_APP (opțional, pentru curățenie)
3. screen_off → închide ecranul
4. Raportează rezultatul
```

**De ce screen_off:**
- Economisește baterie
- Previne burn-in pe ecran
- Device ready pentru următorul job
