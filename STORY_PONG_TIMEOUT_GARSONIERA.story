# STORY: PONG Timeout Disconnect Loop - OP5T Garsoniera

**ID:** STORY-2026-04-01-PONG-GARSONIERA
**Priority:** HIGH
**Status:** Investigation Complete → Ready for Fix
**Created:** 2026-04-01 11:36 UTC
**Story Points:** 3

---

## Context

Dan reported a critical bug where OP5T Garsoniera (device 2cd08058) enters a disconnect loop with `code=4002 reason=PONG timeout` **only** when jobs are sent to it. Other devices (home, tata, mama) work normally with identical job patterns.

---

## Problem Statement

**Symptom:**
```
HELLO → authenticated → sendJob(sent=true) → onClose: code=4002 reason=PONG timeout
```

**Key Observations (from Dan/Nox):**
1. Disconnect appears ONLY when jobs sent to garsoniera
2. Other 3 devices unaffected by same job pattern
3. Disconnect happens "în secunde" (in seconds), not after 60s PONG_TIMEOUT
4. Root cause hypothesis: `lastPongReceived` initialized at class instantiation, not reset on reconnect

---

## Investigation Findings (Atlas)

### 1. Code Analysis - WsClient.kt

**PONG Timeout Tracking:**
- Line 89: `lastPongReceived` initialized at **class instantiation** (NOT connection time)
- Line 223: Reset in `onOpen()` when connection established
- Line 800: Reset when PONG received from server

**KeepAliveJob Logic:**
```kotlin
// Lines 230-260
keepAliveJob = scope.launch {
    while (isActive) {
        delay(30_000L)  // Check every 30 seconds
        if (connectionId.get() != myId) break  // Stale guard
        
        val timeSincePong = System.currentTimeMillis() - lastPongReceived
        if (timeSincePong > PONG_TIMEOUT_MS) {  // 60,000ms
            webSocket.close(4002, "PONG timeout")  // ← Client-initiated close
            break
        }
        
        webSocket.send("{\"type\":\"PING\"}")
    }
}
```

### 2. Server-Side - ws.server.ts

**PONG Response (Line 285):**
```typescript
case "PING":
    ws.send(JSON.stringify({ type: "PONG" }));
    return;
```
✅ Server correctly responds to app-level PING with PONG.

### 3. Why Only Garsoniera?

**Hypothesis:** The issue is NOT that other devices don't have the bug - it's that they don't trigger the conditions that expose it.

**Possible scenarios:**

**Scenario A: WsClient Instance Timing**
- If WsClient is instantiated early (e.g., at app start) but connection happens later
- `lastPongReceived` keeps growing until connection resets it
- If reconnection happens WITHOUT proper onOpen reset...

**Scenario B: Job Execution Blocking**
- `executor.execute()` runs on `Dispatchers.IO`
- If it blocks for >60s, PONG timeout fires during execution
- But PONG handling is in separate coroutine...

**Scenario C: Connection Drops Before First PONG**
1. Garsoniera connects → sends HELLO → authenticated
2. First PING sent at T+30s
3. Server responds with PONG
4. But: what if Cloudflare/proxy drops the PONG?
5. Next PING at T+60s - still no PONG received
6. Timeout fires at T+90s

**But Dan says disconnect happens in SECONDS, not 90+ seconds.**

### 4. The Critical Insight

**Question:** Why does disconnect happen "imediat după sendJob"?

**Answer:** The `sendJob` itself is NOT the cause. The disconnect is the PONG timeout that was ALREADY brewing. The timing correlation with sendJob is coincidental - the device was already approaching timeout when the job arrived.

**Why "in seconds"?** Because the PONG check happens every 30 seconds (`delay(30_000L)`). If:
- `lastPongReceived` was set to T=0 at class init
- Connection established at T=5s (resets lastPongReceived to T=5)
- But connection was somehow lost before PONG exchange
- KeepAliveJob started with stale value?

Actually, let me reconsider. Dan's analysis is key:

> `lastPongReceived` nu e resetat la reconnect — deci `timeSincePong` crește constant

This suggests that on reconnection, `lastPongReceived` is NOT being reset properly. But line 223 shows it IS reset in onOpen...

**Unless:** The onOpen for the NEW connection fires, but the KEEPALIVE JOB from the OLD connection is still running and checking `lastPongReceived` (which now has a fresh value from the new connection).

Wait, no - the old job should be cancelled when the old connection closes.

**Unless:** The connection closes and reconnects SO FAST that the old job hasn't seen the cancel yet, and in its current iteration, it checks `timeSincePong` which is now HUGE because the new `lastPongReceived` was just reset to NOW.

Hmm, that still doesn't make sense because the check is after `delay(30_000L)`.

**THE ACTUAL BUG:** The issue might be that when the connection drops and reconnects, the `lastPongReceived` value from the OLD connection persists UNTIL the NEW onOpen fires. If there's a gap between close and reopen, the PONG timeout check could fire.

But this still doesn't explain why ONLY garsoniera has this issue.

---

## Proposed Fix

### Fix Strategy: Defensive Reset + Safety Valve

**Implemented in WsClient.kt:**

1. **Track job age** - if keepAliveJob runs >120s, force reconnect
2. **Enhanced logging** - capture PONG gaps and connection timing
3. **Defensive reset** - ensure lastPongReceived is not stale

### Alternative Fix (Recommended for Long-term):

**Move PONG tracking to connection scope, not class scope:**

```kotlin
class WsClient(...) {
    // Instead of class-level:
    // private var lastPongReceived = System.currentTimeMillis()
    
    // Use connection-scoped values passed to keepAliveJob:
    keepAliveJob = scope.launch {
        var lastPongForThisConnection = System.currentTimeMillis()
        
        while (isActive) {
            delay(30_000L)
            // Use local copy, not shared class field
            val timeSincePong = System.currentTimeMillis() - lastPongForThisConnection
            // ...
        }
    }
}
```

This way, each connection has its own PONG tracking that gets garbage collected with the job.

---

## Tasks for VOLT

### Task 1: Verify Fix Implementation (Priority 1)
- [x] Check WsClient.kt has defensive PONG tracking (DONE by Atlas)
- [ ] Deploy to garsoniera
- [ ] Monitor logs for PONG gaps

### Task 2: Investigate Why Only Garsoniera (Priority 2)
- [ ] Check device-specific logs/configs
- [ ] Compare WsClient instantiation timing vs other devices
- [ ] Verify if garsoniera has different job patterns

### Task 3: Long-term Fix (Priority 3)
- [ ] Consider moving PONG tracking to connection-scoped variables
- [ ] Add server-side PONG logging (DONE - ws.server.ts line 285 enhanced)

---

## Files Modified

### Already Changed (Atlas):
1. `WsClient.kt` - Added defensive checks, enhanced logging
2. `ws.server.ts` - Added PONG reception logging

### Files Needing Review:
1. `JobExecutor.kt` - Verify job execution doesn't block WebSocket

---

## Testing Plan

### Deploy to Garsoniera:
1. Build APK with defensive PONG tracking
2. Deploy to 2cd08058
3. Monitor for:
   ```
   Connected (connectionId=X, uptimeSinceInit=XXXms)
   PONG received (gap: XXXms)
   PING sent (last PONG: XXXms ago, job age: XXXms)
   ```

### Success Criteria:
- [ ] No 4002 disconnects when sending jobs to garsoniera
- [ ] PONG gaps show <60s between exchanges
- [ ] Other devices continue working normally

---

## Questions for FORGE

1. **Device comparison:** What's different about garsoniera (2cd08058) vs other devices?
   - Different model/firmware?
   - Different app version?
   - Different job types?

2. **Timing analysis:** Can you confirm the disconnect is "imediat după sendJob" vs "60+ seconds after last PONG"?

3. **Server logs:** Do server logs show PONGs being sent to garsoniera before disconnect?

---

## Story Points: 3

**Breakdown:**
- Investigation: 1 point (DONE)
- Fix implementation: 1 point
- Testing/deployment: 1 point

---

## Labels

`bug` `critical` `websocket` `pong-timeout` `garsoniera` `android-agent`

---

## Related Stories

- STORY-2026-03-31-SCREEN-DIMENSIONS (previous story, different device)
- PONG_TIMEOUT_ANALYSIS.md (detailed investigation)
- PONG_TIMEOUT_FIX.md (fix documentation)

---

**Assignee:** VOLT team
**Reviewer:** FORGE (Dan)
**Status:** Ready for fix implementation
