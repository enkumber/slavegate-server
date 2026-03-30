plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.phonenetwork"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.phonenetwork"
        minSdk = 29          // Android 10 (OP5T fleet minimum)
        targetSdk = 30       // Android 11 — Scoped Storage + package visibility
        versionCode = 42
        versionName = "2.6.7"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        // Enable core library desugaring for Java 8+ APIs and Records
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = "11"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    // APK split by ABI — reduces size; fleet is ARM64
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            isUniversalApk = false
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // ─── Core library desugaring (required for wireguard-android Java Records) ─
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.4")

    // ─── AndroidX core ────────────────────────────────────────────────────────
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")

    // ─── Kotlin coroutines ────────────────────────────────────────────────────
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")

    // ─── WebSocket + HTTP ─────────────────────────────────────────────────────
    // OkHttp 4.x — WebSocket client for server connection
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // ─── Security (EncryptedSharedPreferences for WireGuard keys) ────────────
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // ─── WireGuard VPN (native Android VPN, no root needed) ──────────────────
    // Using older version compatible with AGP 8.x and minSdk 29
    implementation("com.wireguard.android:tunnel:1.0.20210926")

    // ─── CameraX + ML Kit (QR Scanner) ───────────────────────────────────────
    implementation("androidx.camera:camera-camera2:1.3.1")
    implementation("androidx.camera:camera-lifecycle:1.3.1")
    implementation("androidx.camera:camera-view:1.3.1")
    implementation("com.google.mlkit:barcode-scanning:17.2.0")

    // ─── ML Kit Text Recognition (OCR — bundled, offline capable) ────────────
    // Used by OcrController for cascade-tap Level 3: text detection on screen
    // Bundled model (+~3MB APK) — no internet required at runtime
    implementation("com.google.mlkit:text-recognition:16.0.0")

    // ─── Lifecycle (ForegroundService + coroutines scope) ────────────────────
    implementation("androidx.lifecycle:lifecycle-service:2.6.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.6.2")

    // ─── Testing ──────────────────────────────────────────────────────────────
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
}
