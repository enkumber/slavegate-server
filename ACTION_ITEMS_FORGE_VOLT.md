# ACTION REQUIRED: FORGE + VOLT

## Bug: PONG Timeout Loop - OP5T Garsoniera

**Full story:** `STORY_PONG_TIMEOUT_GARSONIERA.story`

---

## FORGE → Analysis Task

**Question:** Why is ONLY garsoniera (2cd08058) affected when other 3 devices work fine?

**Investigate:**
1. Device differences (model, firmware, app version, job types)
2. Server logs - do PONGs reach garsoniera before disconnect?
3. Timing analysis - confirm if disconnect is "immediate after sendJob" or "60s+ after last PONG"

**Files to review:**
- `/workspace-kraken/phone-network-server/` - server logs for device 2cd08058
- `BUG_REPORT_PONG_GARSONIERA.md` - full problem description

---

## VOLT → Fix Task

**Status:** Defensive fix already implemented by Atlas

**What was done:**
1. `WsClient.kt` - Added defensive PONG tracking with job age safety valve
2. `ws.server.ts` - Added PONG reception logging

**Files modified:**
- `WsClient.kt` (lines ~89, ~223, ~230-260, ~800)
- `ws.server.ts` (line ~285)

**What VOLT needs to do:**
1. Deploy updated APK to garsoniera (2cd08058)
2. Deploy updated server with PONG logging
3. Monitor logs for:
   ```
   Connected (connectionId=X, uptimeSinceInit=XXXms)
   PONG received (gap: XXXms)
   PING sent (last PONG: XXXms ago, job age: XXXms)
   ```
4. Verify no more 4002 disconnects

**Success criteria:**
- [ ] Garsoniera stays connected when receiving jobs
- [ ] PONG gaps < 60s consistently
- [ ] Other devices unaffected

---

## Quick Reference

**Problem:** Device disconnects with `code=4002 reason=PONG timeout` only when jobs sent to garsoniera

**Root cause hypothesis:** `lastPongReceived` not properly reset on reconnection, causing timeout to fire in seconds instead of 60s

**Code location:** `WsClient.kt` lines 89, 223, 230-260, 800

**Server location:** `ws.server.ts` line 285

**Story doc:** `STORY_PONG_TIMEOUT_GARSONIERA.story`
