#!/bin/bash
# Verification script for screen dimensions audit

set -e

echo "🔍 Screen Dimensions Audit Verification"
echo "========================================"
echo ""

ANDROID_SRC="app/src/main/kotlin/com/phonenetwork"

# Check 1: ScreenMetrics utility exists
echo "✓ Checking ScreenMetrics utility..."
if [ -f "$ANDROID_SRC/utils/ScreenMetrics.kt" ]; then
    echo "  ✅ ScreenMetrics.kt exists"
else
    echo "  ❌ ScreenMetrics.kt NOT FOUND"
    exit 1
fi

# Check 2: No remaining displayMetrics usage (except in ScreenMetrics itself)
echo ""
echo "✓ Checking for remaining displayMetrics references..."
REMAINING=$(find $ANDROID_SRC -name "*.kt" -not -path "*/utils/ScreenMetrics.kt" -exec grep -l "displayMetrics.heightPixels\|displayMetrics.widthPixels" {} \; 2>/dev/null || true)

if [ -z "$REMAINING" ]; then
    echo "  ✅ No remaining displayMetrics.heightPixels/widthPixels usage"
else
    echo "  ❌ Found displayMetrics usage in:"
    echo "$REMAINING"
    exit 1
fi

# Check 3: ScreenMetrics imports present
echo ""
echo "✓ Checking ScreenMetrics imports..."
EXPECTED_FILES=(
    "executor/JobExecutor.kt"
    "automation/AutomationController.kt"
)

for file in "${EXPECTED_FILES[@]}"; do
    if grep -q "import com.phonenetwork.utils.ScreenMetrics" "$ANDROID_SRC/$file" 2>/dev/null; then
        echo "  ✅ $file imports ScreenMetrics"
    else
        echo "  ❌ $file MISSING ScreenMetrics import"
        exit 1
    fi
done

# Check 4: getRealDimensions usage count
echo ""
echo "✓ Checking getRealDimensions() usage..."
USAGE_COUNT=$(find $ANDROID_SRC -name "*.kt" -exec grep -o "ScreenMetrics.getRealDimensions" {} \; | wc -l)
echo "  Found $USAGE_COUNT calls to ScreenMetrics.getRealDimensions()"

if [ "$USAGE_COUNT" -ge 5 ]; then
    echo "  ✅ Expected usage count (≥5 locations updated)"
else
    echo "  ⚠️  Lower than expected (should be ~6-7 locations)"
fi

# Check 5: Critical skill_tap fix
echo ""
echo "✓ Checking critical skill_tap fix..."
if grep -A 10 "private suspend fun executeSkillTap" "$ANDROID_SRC/executor/JobExecutor.kt" | grep -q "ScreenMetrics.getRealDimensions"; then
    echo "  ✅ skill_tap uses ScreenMetrics"
else
    echo "  ❌ skill_tap NOT FIXED"
    exit 1
fi

# Check 6: AutomationController scroll fix
echo ""
echo "✓ Checking AutomationController scroll fix..."
if grep -A 10 "suspend fun scroll" "$ANDROID_SRC/automation/AutomationController.kt" | grep -q "ScreenMetrics.getRealDimensions"; then
    echo "  ✅ scroll() uses ScreenMetrics"
else
    echo "  ❌ scroll() NOT FIXED"
    exit 1
fi

echo ""
echo "========================================"
echo "✅ All verification checks passed!"
echo ""
echo "Summary of changes:"
echo "  • Created: ScreenMetrics utility class"
echo "  • Updated: JobExecutor.kt (6 locations)"
echo "  • Updated: AutomationController.kt (1 location)"
echo "  • Updated: OcrController.kt (documentation)"
echo ""
echo "Next steps:"
echo "  1. Build APK: ./gradlew assembleDebug"
echo "  2. Deploy to test device"
echo "  3. Test skill_tap with y=0.91 (bottom nav)"
echo "  4. Verify coordinate accuracy in logs"
