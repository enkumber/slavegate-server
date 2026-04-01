# PONG Timeout Bug Fix - OP5T Garsoniera

**Date:** 2026-04-01  
**Device:** OP5T Garsoniera (2cd08058)  
**Priority:** High  
**Status:** Fix Implemented, Testing Required

---

## Problem Summary

Device disconnects with `code=4002 reason=PONG timeout` **immediately after sendJob**, not after 60 seconds as expected.

**Pattern:** HELLO → authenticated → sendJob(sent=true) → disconnect

---

## Root Cause Analysis

**Finding:** The PONG timeout logic itself is correct. The issue is likely one of:

1. **Timing gap:** `lastPongReceived` initialized at class instantiation (WsClient created) but connection happens later. If WsClient is created >60s before connection, first check fires immediately.

2. **Race condition:** Old keepAliveJob not properly cancelled before new one starts on reconnection.

3. **Cloudflare proxy:** Not forwarding PING/PONG correctly in some network conditions.

**Investigation confirms:**
- ✅ Server sends PONG correctly (ws.server.ts:285)
- ✅ Client handles PONG correctly (WsClient.kt:782)
- ❓ Device logs needed to confirm PONG reception timing

---

## Fix Applied

**File:** `WsClient.kt`

### Changes Made:

**1. Added defensive job age tracking**
```kotlin
private val classInitializedAt = System.currentTimeMillis()

// In keepAliveJob:
val jobStartedAt = System.currentTimeMillis()

// Added safety valve:
val jobAge = System.currentTimeMillis() - jobStartedAt
if (jobAge > PONG_TIMEOUT_MS * 2) {
    Log.e(TAG, "⚠️ keepAliveJob age ${jobAge}ms > 2x timeout — forcing reconnect")
    webSocket.close(4002, "Job stale")
    break
}
```

**2. Enhanced logging for diagnosis**
```kotlin
// On connection open:
Log.i(TAG, "Connected (connectionId=$connectionId, uptimeSinceInit=${uptime}ms)")

// On PONG received:
Log.d(TAG, "PONG received (gap: ${gap}ms, connectionId=$connectionId)")

// On PING sent:
Log.d(TAG, "PING sent (last PONG: ${timeSincePong}ms ago, job age: ${jobAge}ms)")

// On timeout:
Log.e(TAG, "⚠️ PONG timeout (${timeSincePong}ms > ${PONG_TIMEOUT_MS}ms)")
```

**3. Improved stale connection detection**
```kotlin
if (connectionId.get() != myId) {
    Log.d(TAG, "keepAliveJob: stale connection (gen $myId, current $connectionId) — stopping")
    break
}
```

---

## What This Fix Does

1. **Prevents stale job runs:** If keepAliveJob has been running >120 seconds, it forces a reconnect to reset state
2. **Better diagnostics:** Logs show timing gaps and job age to identify where the issue occurs
3. **Safer reconnection:** Better tracking of which connection generation is active

---

## Testing Required

**Deploy to OP5T Garsoniera and:**

1. **Monitor logs** for:
   ```
   Connected (connectionId=X, uptimeSinceInit=XXXms)
   PONG received (gap: XXXms)
   PING sent (last PONG: XXXms ago, job age: XXXms)
   ```

2. **Reproduce the issue:**
   - Connect device
   - Trigger sendJob
   - Watch for disconnect timing

3. **Key log indicators:**
   - If `uptimeSinceInit > 60000` on connect → WsClient created too early
   - If `gap` in PONG received is large → PONGs not being received
   - If `job age > 120000` before timeout → job running too long

---

## Files Modified

- `app/src/main/kotlin/com/phonenetwork/connection/WsClient.kt`
  - Added `classInitializedAt` tracking
  - Enhanced keepAliveJob with defensive checks
  - Improved logging throughout PONG handling

---

## Additional Recommendations

1. **Server-side logging (ws.server.ts):**
   ```typescript
   case "PING":
       console.log(`[ws] PING from ${state.conn?.deviceId?.slice(0,8)} at ${Date.now()}`);
       ws.send(JSON.stringify({ type: "PONG" }));
       return;
   ```

2. **Consider reducing PONG_TIMEOUT_MS:**
   - Current: 60,000ms (1 minute)
   - Suggested: 45,000ms (45 seconds)
   - This would detect issues faster but increase false positives

3. **Check WsClient instantiation timing:**
   - When is WsClient created relative to connection?
   - If created at app start but connection delayed, could cause issue

---

## Next Steps

1. ✅ Code fix applied
2. ⏳ Deploy to OP5T Garsoniera
3. ⏳ Collect logs showing PONG gaps
4. ⏳ Verify disconnect still occurs (or fix worked)
5. ⏳ If issue persists, add server-side PONG logging

**Assigned:** Dan/Nox for testing
**Follow-up:** Report log output after deployment
