# Screen Dimensions Audit & Fix

**Date:** 2026-03-31  
**Priority:** High  
**Status:** ✅ Complete

## Bug Summary

**Critical inconsistency discovered:** `displayMetrics.heightPixels` returns screen height **excluding** navigation bar (e.g., 2034px on Redmi Note 13), but UI accessibility tree bounds use **full screen** dimensions including nav bar (2160px).

### Impact

This caused `skill_tap` with normalized coordinates to tap in the **wrong location**:

```kotlin
// BEFORE (BROKEN):
val screenHeight = displayMetrics.heightPixels  // = 2034px (excludes nav bar)
val pixelY = (0.91 * 2034).toInt()             // = 1850px
// But bottom_nav actually starts at 1903px → tap misses!
```

**Root cause:** Normalized coordinates calculated against one dimension system (2034px) but applied to elements measured in another (2160px).

---

## Solution: `ScreenMetrics` Utility

Created `/app/src/main/kotlin/com/phonenetwork/utils/ScreenMetrics.kt`:

```kotlin
object ScreenMetrics {
    fun getRealDimensions(context: Context): Pair<Int, Int> {
        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val realMetrics = DisplayMetrics()
        windowManager.defaultDisplay.getRealMetrics(realMetrics)
        return Pair(realMetrics.widthPixels, realMetrics.heightPixels)
    }
    
    fun getRealWidth(context: Context): Int
    fun getRealHeight(context: Context): Int
}
```

**Why `getRealMetrics()`?**
- `displayMetrics.heightPixels` → excludes system UI (nav bar, status bar)
- `getRealMetrics()` → **includes all system UI** → matches accessibility tree bounds

---

## Files Updated

### 1. `JobExecutor.kt` (6 locations)

**Line ~289** — `ocr_find_tap` screen dimensions:
```kotlin
// BEFORE:
val metrics = context.resources.displayMetrics
val screenWidth = metrics.widthPixels
val screenHeight = metrics.heightPixels

// AFTER:
val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)
```

**Line ~357** — `ocr_full` screen dimensions:
```kotlin
// Same change as above
```

**Line ~476-501** — `unlock_screen` swipe + pattern:
```kotlin
// BEFORE:
val metrics = context.resources.displayMetrics
val centerX = metrics.widthPixels / 2
val startY = metrics.heightPixels * 3 / 4
// ... pattern grid also used metrics

// AFTER:
val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)
val centerX = screenWidth / 2
val startY = screenHeight * 3 / 4
// Pattern grid now uses screenWidth/screenHeight
```

**Line ~840** — `skill_tap` (THE CRITICAL FIX):
```kotlin
// BEFORE:
val displayMetrics = context.resources.displayMetrics
val screenWidth = displayMetrics.widthPixels
val screenHeight = displayMetrics.heightPixels
val pixelY = (normalizedY * screenHeight).toInt()  // WRONG!

// AFTER:
val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)
val pixelY = (normalizedY * screenHeight).toInt()  // CORRECT!
```

**Line ~897** — `a11y_find_tap` coordinate normalization:
```kotlin
// Same fix as skill_tap
```

---

### 2. `AutomationController.kt` (1 location)

**Line ~225** — `scroll()` center calculation:
```kotlin
// BEFORE:
val dm = svc.resources.displayMetrics
val cx = dm.widthPixels / 2
val cy = dm.heightPixels / 2

// AFTER:
val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(svc)
val cx = screenWidth / 2
val cy = screenHeight / 2
```

---

### 3. `OcrController.kt` (documentation)

Updated usage example in file header:
```kotlin
// BEFORE:
screenWidth = metrics.widthPixels,

// AFTER:
val (screenWidth, screenHeight) = ScreenMetrics.getRealDimensions(context)
```

---

## Verification Checklist

- [x] All `displayMetrics.heightPixels` replaced with `ScreenMetrics.getRealHeight()`
- [x] All `displayMetrics.widthPixels` replaced with `ScreenMetrics.getRealWidth()`
- [x] **skill_tap** normalized coordinate conversion fixed
- [x] **ocr_find_tap** coordinate scaling fixed
- [x] **a11y_find_tap** coordinate normalization fixed
- [x] **scroll** gesture center calculation fixed
- [x] **unlock_screen** swipe + pattern coordinates fixed
- [x] OCR controller documentation updated
- [x] No remaining `context.resources.displayMetrics` calls for dimensions

---

## Testing Instructions

### Before Testing
1. Deploy updated APK to Redmi Note 13 (or device with nav bar)
2. Enable developer logging for coordinate validation

### Test Cases

**Test 1: skill_tap bottom navigation**
```json
{
  "type": "skill_tap",
  "params": {
    "x": 0.5,
    "y": 0.91,
    "skillId": "instagram_nav",
    "buttonId": "profile"
  }
}
```
**Expected:** Tap hits bottom nav button accurately (previously missed)

**Test 2: ocr_find_tap with text near nav bar**
```json
{
  "type": "ocr_find_tap",
  "params": {
    "searchText": "Settings",
    "partialMatch": false
  }
}
```
**Expected:** Taps text elements near screen bottom correctly

**Test 3: unlock_screen pattern**
```json
{
  "type": "unlock_screen",
  "params": {
    "pattern": [0, 1, 2, 5, 8]
  }
}
```
**Expected:** Pattern gesture covers full screen height (not cut off)

**Test 4: scroll to bottom**
```json
{
  "type": "scroll",
  "params": {
    "direction": "down",
    "distancePx": 800
  }
}
```
**Expected:** Scroll gesture uses full screen center (including nav bar space)

---

## Deployment Notes

**Build version:** Update to v3.3.0+ (screen dimensions fix)  
**Breaking changes:** None (internal coordinate fix)  
**Rollback risk:** Low (purely additive utility class)

**Server-side implications:**
- Skill learning with normalized coordinates will now be accurate
- Previous learned coords may need re-calibration on devices with nav bars
- Consider adding `device_screen_height_real` to device info payload

---

## Future Considerations

### 1. Device Info Payload
Add real dimensions to device registration:
```json
{
  "screenWidth": 1080,
  "screenHeight": 2160,
  "screenHeightExcludingNav": 2034,
  "navBarHeight": 126
}
```

### 2. Skill Coordinate Validation
Server could detect mismatches:
```javascript
if (Math.abs(learnedHeight - deviceHeight) > 100) {
  console.warn("Skill learned on different screen dimensions");
}
```

### 3. Multi-Device Skill Portability
Normalized coordinates now **truly normalized** → better cross-device skill sharing.

---

## References

- **Bug report:** Story request from Dan via Nox
- **Android docs:** [`WindowManager.getDefaultDisplay().getRealMetrics()`](https://developer.android.com/reference/android/view/Display#getRealMetrics(android.util.DisplayMetrics))
- **Related files:**
  - `JobExecutor.kt`
  - `AutomationController.kt`
  - `OcrController.kt`
  - `ScreenMetrics.kt` (new)

---

**Audit completed by:** Atlas  
**Verification required:** Deploy + test skill_tap accuracy on nav bar elements
