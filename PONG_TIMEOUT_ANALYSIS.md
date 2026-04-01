# PONG Timeout Disconnect Loop - Investigation Report

**Device:** OP5T Garsoniera (2cd08058)  
**Pattern:** HELLO → authenticated → sendJob(sent=true) → disconnect `code=4002 reason=PONG timeout`  
**Date:** 2026-04-01  
**Investigator:** Atlas

---

## Executive Summary

The device disconnects with PONG timeout (4002) in **seconds**, not the expected 60 seconds. This suggests `lastPongReceived` is being set to a timestamp in the past, OR the PONG tracking is fundamentally broken.

---

## Code Analysis

### Client-Side (WsClient.kt)

**PONG Timeout Logic (lines 229-243):**
```kotlin
keepAliveJob = scope.launch {
    while (isActive) {
        delay(30_000L)  // Wait 30s between checks
        if (connectionId.get() != myId) break  // Stale connection guard
        
        // Check PONG timeout BEFORE sending next PING
        val timeSincePong = System.currentTimeMillis() - lastPongReceived
        if (timeSincePong > PONG_TIMEOUT_MS) {  // 60,000ms
            Log.e(TAG, "⚠️ PONG timeout (${timeSincePong}ms) — zombie connection, forcing reconnect")
            webSocket.close(4002, "PONG timeout")
            break
        }
        
        webSocket.send("{\"type\":\"PING\"}")
        Log.d(TAG, "PING sent (last PONG: ${timeSincePong}ms ago)")
    }
}
```

**PONG Tracking Initialization:**
```kotlin
// Line 89: Class field initialization
private var lastPongReceived = System.currentTimeMillis()

// Line 222: Reset on connection open
override fun onOpen(webSocket: WebSocket, response: Response) {
    // ...
    lastPongReceived = System.currentTimeMillis()  // Reset for new connection
    // ...
}

// Line 782: Reset when PONG received
"PONG" -> {
    lastPongReceived = System.currentTimeMillis()
    Log.d(TAG, "PONG received")
}
```

### Server-Side (ws.server.ts)

**PONG Response (line 285):**
```typescript
case "PING":
    ws.send(JSON.stringify({ type: "PONG" }));
    return;
```

---

## Investigation Questions

### 1. ✅ Server responds correctly to app-level PING?

**Answer:** YES
- Line 285 of ws.server.ts confirms server sends `{"type":"PONG"}` when receiving `{"type":"PING"}`
- Format matches what client expects (line 782 in WsClient.kt)

### 2. ❓ Does phone receive PONG? (Cannot verify without device logs)

**Cannot determine** - need device-side logs to confirm PONG is received and processed.

### 3. ❓ Is `timeSincePong` calculated correctly?

**Analysis:**
```kotlin
val timeSincePong = System.currentTimeMillis() - lastPongReceived
```

This calculation is **mathematically correct** IF:
- `lastPongReceived` is set to `System.currentTimeMillis()` when PONG is received
- No overflow or timezone issues

**Potential Issue:** If the phone's `lastPongReceived` was initialized to a past timestamp (e.g., class instantiated 70+ seconds before connection), AND the onOpen reset doesn't happen properly, the first check could fire immediately.

**But:** The code shows onOpen SHOULD reset `lastPongReceived` to NOW.

### 4. ❓ Why disconnect in seconds, not 60s?

**Root Cause Hypothesis:**

The `delay(30_000L)` is at the **START** of the loop. So even if `timeSincePong > 60_000ms` when entering the loop, it would:
1. Check condition
2. If true → close immediately
3. If false → delay 30s, then check again

**For disconnect in SECONDS:** The condition `timeSincePong > PONG_TIMEOUT_MS` must be TRUE immediately upon entering the loop.

**This means `lastPongReceived` must be set to a time 60+ seconds in the past.**

---

## Potential Root Causes

### Hypothesis 1: Race Condition in Connection Establishment

**Scenario:**
1. Connection attempt #1 starts
2. Connection attempt #2 starts (closes #1's socket)
3. Attempt #1's onOpen fires, sets `lastPongReceived = NOW`
4. Attempt #2's onOpen fires, sets `lastPongReceived = NOW`
5. keepAliveJob from #1 runs with old `myId` but new `connectionId`
6. Check `connectionId.get() != myId` → TRUE → job should break

**Analysis:** The stale guard should prevent this. But what if there's a timing issue?

### Hypothesis 2: Class Instantiation Time vs Connection Time Gap

**Scenario:**
1. WsClient class instantiated at T=0 → `lastPongReceived = T=0`
2. For some reason, connection doesn't establish until T=70s
3. At T=70s, onOpen sets `lastPongReceived = T=70`
4. But if onOpen is called but `lastPongReceived` assignment fails silently...

**Analysis:** Unlikely - Kotlin assignments don't fail silently.

### Hypothesis 3: **KeepAliveJob Starts BEFORE onOpen Completes**

**Scenario:**
1. `ws?.close(1000, "Reconnecting")` is called (line 203)
2. Old keepAliveJob is cancelled by `keepAliveJob?.cancel()` (line 228)
3. But a NEW keepAliveJob is started BEFORE onOpen is called?
4. New keepAliveJob runs with `lastPongReceived = T=0` (class init time)
5. First iteration: `timeSincePong = NOW - T=0 = 70+ seconds` → IMMEDIATE TIMEOUT!

**Evidence:** Looking at the code flow:
```kotlin
// Line 200-203: Close previous socket
ws?.close(1000, "Reconnecting")
ws = null

// Line 205-217: Build new request and create new websocket
// onOpen callback is set up but NOT YET CALLED

// Line 218: ws = client.newWebSocket(request, object : WebSocketListener() {
```

The WebSocket is created at line 218. The `onOpen` callback is set up but won't fire until the connection is actually established. But the keepAliveJob is also started in onOpen (line 228-229).

**Wait - let me re-read more carefully:**

```kotlin
override fun onOpen(webSocket: WebSocket, response: Response) {
    // ...
    keepAliveJob?.cancel()
    keepAliveJob = scope.launch {  // This is INSIDE onOpen
        // ...
    }
}
```

So keepAliveJob is started INSIDE onOpen, AFTER `lastPongReceived = System.currentTimeMillis()`.

**But what if there's a second connection attempt happening?**

Looking at line 187-192:
```kotlin
connectingWatchdogJob = scope.launch {
    delay(CONNECTING_TIMEOUT_MS)  // 45 seconds
    if (connectionId.get() == myId && isConnecting.get()) {
        ws?.close(4003, "Connecting timeout")
        // ...
    }
}
```

If the first connection attempt times out after 45 seconds, it closes the socket. But the keepAliveJob should have been cancelled when the old connection closed... unless there's a race.

### Hypothesis 4: **Server Not Sending PONG (Cloudflare Proxy Issue)**

**Scenario:**
- Phone sends PING
- Cloudflare proxy doesn't forward PING to server OR doesn't forward PONG back
- Phone never receives PONG
- 60 seconds later: timeout fires

**But:** Dan says disconnect happens in SECONDS, not 60 seconds.

**Unless:** The phone was already in a "waiting for PONG" state before the job was sent.

### Hypothesis 5: **Message Handling Blocking PONG Processing**

**Scenario:**
1. JOB_DISPATCH received
2. Handler launches `scope.launch { executor.execute(...) }`
3. If the executor job blocks the scope's thread pool...
4. Incoming PONG messages might be delayed

**But:** PONG handling is in `handleMessage` which is launched separately:
```kotlin
override fun onMessage(webSocket: WebSocket, text: String) {
    scope.launch { handleMessage(text) }
}
```

Each message gets its own coroutine. This shouldn't block PONG processing.

---

## Most Likely Root Cause

**Hypothesis: Timing Issue with `lastPongReceived` Initialization**

The most suspicious code is:
```kotlin
private var lastPongReceived = System.currentTimeMillis()  // Line 89
```

This is initialized at **class instantiation** time, not connection time.

**If the WsClient is created but doesn't connect for >60 seconds, the first keepAliveJob iteration will immediately timeout.**

**Why would this happen right after sendJob?**

Maybe sendJob triggers a reconnection, and during that reconnection, the WsClient is re-created (or the old one is reused with a fresh WebSocket but old `lastPongReceived` value).

**Or - the connection IS established, but there's a bug where `lastPongReceived` is NOT being reset in onOpen.**

---

## Proposed Fixes

### Fix 1: Add Defensive Reset in keepAliveJob

Add a check at the start of keepAliveJob to ensure `lastPongReceived` is not in the future or too far in the past:

```kotlin
keepAliveJob = scope.launch {
    // Defensive: ensure lastPongReceived is recent
    val now = System.currentTimeMillis()
    if (now - lastPongReceived > PONG_TIMEOUT_MS) {
        lastPongReceived = now  // Reset if we somehow started with stale data
    }
    
    while (isActive) {
        delay(30_000L)
        // ...
    }
}
```

### Fix 2: Add Logging for PONG Tracking

Add more detailed logging to diagnose the issue:

```kotlin
"PONG" -> {
    val prevPong = lastPongReceived
    lastPongReceived = System.currentTimeMillis()
    Log.d(TAG, "PONG received (gap: ${lastPongReceived - prevPong}ms)")
}
```

### Fix 3: Verify onOpen Always Resets lastPongReceived

Ensure the reset happens unconditionally:

```kotlin
override fun onOpen(webSocket: WebSocket, response: Response) {
    // ... other code ...
    
    // Reset PONG tracking for new connection
    lastPongReceived = System.currentTimeMillis()
    Log.d(TAG, "PONG tracking reset in onOpen")
    
    // ...
}
```

### Fix 4: (Recommended) Add Connection Age Check

Before starting keepAliveJob, verify the connection is fresh:

```kotlin
keepAliveJob = scope.launch {
    // Ensure we're tracking a fresh connection
    val connectionStartTime = System.currentTimeMillis()
    
    while (isActive) {
        delay(30_000L)
        
        // Safety reset if this job has been running longer than expected
        if (System.currentTimeMillis() - connectionStartTime > PONG_TIMEOUT_MS * 2) {
            Log.w(TAG, "keepAliveJob running too long - connection may be stale")
            webSocket.close(4002, "Connection stale")
            break
        }
        
        // ... rest of logic
    }
}
```

---

## Recommended Investigation Steps

1. **Add device-side logging** to capture:
   - When onOpen fires and what value it sets for lastPongReceived
   - When PONG is received and the gap from previous
   - When keepAliveJob checks timeSincePong

2. **Add server-side logging** to capture:
   - When PING is received from device
   - When PONG is sent to device

3. **Check Cloudflare proxy** settings:
   - Idle timeout (100s is mentioned in code)
   - Whether WebSocket pings are being forwarded correctly

4. **Verify timing** on device:
   - Is System.currentTimeMillis() reliable?
   - Is there any time zone or locale issue?

---

## Next Steps

1. Add the defensive reset fix (Fix 1) to WsClient.kt
2. Add detailed PONG tracking logs
3. Build and deploy to OP5T Garsoniera
4. Collect logs showing PONG gaps
5. Verify server-side PONG sending

**Priority:** High - device is in disconnect loop
**Estimated fix time:** 1-2 hours including testing
