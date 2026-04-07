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
        targetSdk = 34       // Android 14
        versionCode = 49
        versionName = "3.0.9"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            storeFile = file("release.keystore")
            storePassword = project.findProperty("KEYSTORE_PASSWORD") as? String ?: System.getenv("KEYSTORE_PASSWORD") ?: ""
            keyAlias = "phone-network"
            keyPassword = project.findProperty("KEY_PASSWORD") as? String ?: System.getenv("KEY_PASSWORD") ?: ""
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("release")
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
    // ─── Core library desugaring (for Java 8+ APIs on older Android) ─────────────
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
