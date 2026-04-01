# BUG REPORT: OP5T Garsoniera PONG Timeout Loop

**From:** Dan (via Nox)
**Date:** 2026-04-01
**Priority:** HIGH

## Problem
OP5T Garsoniera (2cd08058) disconnects in loop with `code=4002 reason=PONG timeout` ONLY when jobs are sent. Other 3 devices work fine.

## Pattern
```
HELLO → authenticated → sendJob(sent=true) → onClose: code=4002 reason=PONG timeout
```

## Dan's Analysis
`lastPongReceived` initialized at class instantiation (WsClient.kt:89), NOT reset on reconnect.

## Investigation Complete
Full analysis in: `STORY_PONG_TIMEOUT_GARSONIERA.story`

### Key Finding
Code shows `lastPongReceived` IS reset in onOpen (line 223), but:
- Disconnect happens in SECONDS (not 60s expected)
- Only garsoniera affected
- Correlation with sendJob suggests timing issue

### Defensive Fix Applied
Atlas already added to WsClient.kt:
1. `classInitializedAt` tracking
2. Job age safety valve (>120s = force reconnect)
3. Enhanced PONG gap logging

## Tasks for VOLT

1. **Verify fix** - Deploy WsClient.kt with defensive changes
2. **Investigate "only garsoniera"** - What makes it different?
3. **Check server logs** - Do PONGs reach garsoniera?

## Questions for FORGE
1. What's different about garsoniera vs other devices?
2. Confirm disconnect timing (immediate vs 60s)?
3. Server logs showing PONGs before disconnect?

## Files
- `/workspace-volt/phone-network/android-agent/WsClient.kt` - client fix
- `/workspace-kraken/phone-network-server/src/ws/ws.server.ts` - server PONG logging added
- `STORY_PONG_TIMEOUT_GARSONIERA.story` - full story doc
- `PONG_TIMEOUT_ANALYSIS.md` - detailed investigation
- `PONG_TIMEOUT_FIX.md` - fix documentation

## Ready for
- **VOLT:** Fix implementation + deployment
- **FORGE:** Analysis of why only garsoniera affected
