# vision — Phase 3

Vision Understanding Layer — agent side.

## What goes here

- `VisionClient.kt` — sends VISION_REQUEST to server, receives VISION_RESULT
- `ScreenElementMapper.kt` — maps AccessibilityService nodes → ScreenElement (normalizes primary source)
- `ScreenshotOptimizer.kt` — resize to max 1280px + JPEG 80% before sending to server

## Key principle

Agent does NOT know which VLM is used. It sends a screenshot + prompt to server,
receives structured ScreenElement[] back. VLM provider is fully server-side.

## Phase 1: stub

Vision layer not active in Phase 1. AccessibilityService is used directly.

```kotlin
// All element finding goes through AccessibilityService in Phase 1.
// Vision fallback activation: Phase 3.
```

## ScreenElement (shared with server)

```kotlin
data class ScreenElement(
    val type: String,           // "button", "text", "image", "input", "container"
    val text: String?,
    val contentDescription: String?,
    val bounds: Rect,
    val resourceId: String?,    // null for VLM-sourced
    val className: String?,     // null for VLM-sourced
    val isClickable: Boolean,
    val isScrollable: Boolean,
    val confidence: Float,      // 1.0 for A11y, 0.0-1.0 for VLM
    val source: String          // "accessibility" | "vlm"
)
```

## Flow (Phase 3)

```
AutomationController → find element:
  1. Try AccessibilityService → ScreenElement (source=accessibility)
  2. If not found / confidence too low:
     → VisionClient.sendRequest(screenshot, prompt, "element_find")
     → Wait for VISION_RESULT from server
     → ScreenElement[] (source=vlm)
  3. Use element bounds for action
```
