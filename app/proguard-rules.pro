# Phone Network Agent — ProGuard rules

# Keep agent entry points
-keep class com.phonenetwork.** { *; }

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase

# Kotlin coroutines
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-dontwarn kotlinx.coroutines.**

# Android Keystore — referenced by name at runtime
-keep class android.security.keystore.** { *; }

# Accessibility service metadata
-keep class * extends android.accessibilityservice.AccessibilityService { *; }

# Keep JSON field names (used in protocol messages)
-keepclassmembers class * {
    @org.json.JSONObject *;
}

# Rust Nostr SDK native libs
-keep class rust.nostr.** { *; }
-keepclassmembers class rust.nostr.** { *; }
