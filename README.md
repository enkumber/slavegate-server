# Android Agent

Kotlin Android agent — pure executor. Zero business logic.

## Modules

| Module | Status | Description |
|--------|--------|-------------|
| `connection/WsClient.kt` | ✅ Phase 1 | WebSocket lifecycle, reconnect, adaptive heartbeat |
| `auth/TokenStore.kt` | ✅ Phase 1 | Encrypted token + UUID persistence (Android Keystore) |
| `executor/JobExecutor.kt` | ✅ Phase 1 | Job routing — all whitelisted types |
| `health/HealthMonitor.kt` | ✅ Phase 1 | Battery, storage, thermal, network metrics |
| `automation/AutomationController.kt` | 🟡 Stub | AccessibilityService-based tap/swipe/scroll/type |
| `capture/CaptureController.kt` | 🟡 Stub | Screenshot, screen recording |
| `ota/OtaInstaller.kt` | 🟡 Stub | Download, verify (SHA256 + signature), install |

## Build

```bash
cd android-agent
./gradlew assembleDebug     # debug APK
./gradlew assembleRelease   # release APK (requires signing config)
```

## Key decisions

- **AccessibilityService** is the primary automation method, not root input injection
- **Root used only for:** `pm install`, `pm uninstall`, `reboot`
- **No generic shell execution** — all root commands go through explicit method calls
- **Token** stored encrypted in Android Keystore (AES-256-GCM)
- **Device UUID** stored in file — stable across token rotations, survives reinstall
- **Jitter** applied server-side — agent executes coordinates as-is

## Configuration

Server URL is read from `BuildConfig.SERVER_URL` (set in `build.gradle.kts`):

```kotlin
buildConfigField("String", "SERVER_URL", "\"wss://your-tunnel.trycloudflare.com/ws\"")
```
