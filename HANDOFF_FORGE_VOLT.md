# HANDOFF: PONG Timeout Bug - OP5T Garsoniera

**Created:** 2026-04-01 12:19 UTC  
**From:** Atlas (investigation)  
**To:** FORGE (analysis) + VOLT (deployment)

---

## 🔴 BUG DESCRIPTION

**Device:** OP5T Garsoniera (2cd08058)  
**Symptom:** Disconnect loop with `code=4002 reason=PONG timeout`  
**Trigger:** ONLY when jobs are sent to this device  
**Pattern:** `HELLO → authenticated → sendJob(sent=true) → onClose: code=4002`

---

## 📋 FORGE → Investigation Task

**Question:** De ce DOAR garsoniera e afectată când alte 3 device-uri (home, tata, mama) funcționează normal cu același pattern?

### Investighează:
1. **Device differences** — model, firmware, app version, job types
2. **Server logs** — verifică dacă PONG-urile ajung la 2cd08058 înainte de disconnect
3. **Timing analysis** — confirmă dacă disconnect e "imediat după sendJob" sau "60s+ după last PONG"

### Log Server to Check:
```bash
# Server-side PING logging added (ws.server.ts:285)
grep "PING from device=2cd08058" server.log
```

### Deliverable:
- De ce e garsoniera diferită?
- Root cause confirmat sau noi ipoteze

---

## ⚡ VOLT → Deployment Task

**Status:** Fix gata implementat de Atlas

### Files Modified:

**1. WsClient.kt** (android-agent)
```
- Line ~89: Added classInitializedAt tracking
- Line ~223: Enhanced PONG reset logging  
- Lines ~230-260: Defensive job age safety valve (>120s = force reconnect)
- Lines ~799-800: Enhanced PONG gap logging
```

**2. ws.server.ts** (phone-network-server)
```
- Line ~285: Added PING reception logging
```

### Deployment Steps:

**1. Build Android APK:**
```bash
cd /data/.openclaw/workspace-volt/phone-network/android-agent
./gradlew assembleDebug
```

**2. Deploy to Garsoniera (2cd08058):**
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**3. Deploy Server:**
```bash
cd /data/.openclaw/workspace-kraken/phone-network-server
# Rebuild and deploy with PONG logging
```

**4. Monitor Logs:**
```
Connected (connectionId=X, uptimeSinceInit=XXXms)
PONG received (gap: XXXms)
PING sent (last PONG: XXXms ago, job age: XXXms)
```

### Success Criteria:
- [ ] Garsoniera STAYS connected when receiving jobs
- [ ] PONG gaps < 60s consistently  
- [ ] Other devices unaffected

---

## 📁 References

- **Story:** `STORY_PONG_TIMEOUT_GARSONIERA.story`
- **Analysis:** `PONG_TIMEOUT_ANALYSIS.md`
- **Fix Doc:** `PONG_TIMEOUT_FIX.md`
- **Bug Report:** `BUG_REPORT_PONG_GARSONIERA.md`

---

## ⏱️ Timeline

- **12:19 UTC** — Atlas investigation complete, fix applied
- **12:21 UTC** — Handoff to FORGE + VOLT
- **TBD** — FORGE investigation complete
- **TBD** — VOLT deployment + testing

---

## ❓ Open Questions

1. De ce doar garsoniera e afectată?
2. PONG-urile ajung la device înainte de disconnect?
3. Fix-ul rezolvă problema sau e nevoie de investigație suplimentară?

---

**Atlas → FORGE + VOLT handoff complete**
