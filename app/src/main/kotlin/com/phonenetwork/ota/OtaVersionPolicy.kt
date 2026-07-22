package com.phonenetwork.ota

/** Pure version policy kept separate from Android I/O so every OTA gate is unit tested. */
object OtaVersionPolicy {
    fun validate(
        declaredVersionCode: Long,
        apkVersionCode: Long,
        installedVersionCode: Long,
        forceDowngrade: Boolean,
    ) {
        require(declaredVersionCode > 0L) {
            "Invalid declared OTA versionCode: $declaredVersionCode"
        }
        require(apkVersionCode > 0L) {
            "Could not read versionCode from downloaded APK"
        }
        require(installedVersionCode > 0L) {
            "Could not read installed versionCode"
        }
        require(declaredVersionCode == apkVersionCode) {
            "OTA metadata mismatch: declared=$declaredVersionCode, apk=$apkVersionCode"
        }

        if (!forceDowngrade && apkVersionCode < installedVersionCode) {
            throw IllegalStateException(
                "Downgrade prevented: installed=$installedVersionCode, target=$apkVersionCode"
            )
        }
    }
}
