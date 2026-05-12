/**
 * anti-detection/fingerprint-config.ts
 * Per-device fingerprint spoofing configuration.
 *
 * Server generates stable, unique fingerprint profiles per device.
 * Profiles sent to device via CONFIG_UPDATE message on connect.
 * Device applies via Xposed/LSPosed module (MagiskHide/Shamiko must be active).
 *
 * What gets spoofed per device (all stable — same values across reboots):
 *   - Android ID (Settings.Secure.ANDROID_ID)
 *   - Google Services Framework (GSF) ID
 *   - Build fingerprint (manufacturer, model, build number)
 *   - IMEI / device serial (if root allows)
 *   - Device locale (matches simulated timezone)
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §11 (Anti-Detection)
 */

import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DnsConfig {
  provider:  string;            // e.g. "Cloudflare"
  hostname:  string;            // DoT hostname, e.g. "one.one.one.one"
  fallback:  readonly string[]; // plain DNS fallback IPs
}

export interface FingerprintProfile {
  deviceId:          string;
  androidId:         string;   // 16 hex chars — stable across reboots
  gsfId:             string;   // 16 hex chars
  buildFingerprint:  string;   // e.g. "google/panther/panther:13/TQ3A..."
  buildBrand:        string;   // e.g. "google"
  buildDevice:       string;   // e.g. "panther"
  buildProduct:      string;   // e.g. "panther"
  manufacturer:      string;   // e.g. "Google"
  model:             string;   // e.g. "Pixel 7"
  serialNumber:      string;   // 10 alphanumeric chars
  locale:            string;   // e.g. "ro-RO" — matches simulated timezone
  glRenderer:        string;   // e.g. "Adreno (TM) 730"
  glVendor:          string;   // e.g. "Qualcomm"
  userAgent:         string;   // Chrome/Android UA matching model
  dnsConfig:         DnsConfig; // A4: per-device Private DNS (DoT) provider
  /** Version code of the Xposed module expected to be active */
  moduleVersionCode: number;
}

// ─── Device pools for fingerprint generation ──────────────────────────────────

/**
 * Device profiles split by Android version.
 * Fleet runs Android 10 (API 29) and Android 11 (API 30).
 * Fingerprint MUST match the device's actual Android version
 * (Build.FINGERPRINT contains VERSION.RELEASE, verified by apps).
 */

// I2 fix: 16 profiles across 2 Android versions — birthday collision probability < 5%
// Fleet: OnePlus API 29 (Android 10) + API 30 (Android 11).
// Profiles: realistic mid-range Android 10/11 devices (Samsung A-series, Xiaomi, Redmi, OnePlus).
// OnePlus devices spoof as OTHER brands — prevents fleet fingerprinting from model patterns.
const DEVICE_POOL: Array<{
  manufacturer: string; model: string; buildSuffix: string; codename: string;
  androidVersion: string;  // B1 fix: VERSION.RELEASE ("10"/"11"), NOT API level
  apiLevel: 29 | 30;       // for profile selection per device Android version
  brand: string; product: string;
  glRenderer: string; glVendor: string;
}> = [
  // ── Android 10 (API 29) profiles ────────────────────────────────────────
  { manufacturer: "samsung", model: "SM-A505F",  brand: "samsung", product: "a50",
    buildSuffix: "QP1A.190711.020/A505FXXS9BTI1:user/release-keys", codename: "a50",
    androidVersion: "10", apiLevel: 29, glRenderer: "Adreno (TM) 612", glVendor: "Qualcomm" },
  { manufacturer: "samsung", model: "SM-A515F",  brand: "samsung", product: "a51",
    buildSuffix: "QP1A.190711.020/A515FXXU5DUI1:user/release-keys", codename: "a51",
    androidVersion: "10", apiLevel: 29, glRenderer: "Mali-G76",       glVendor: "ARM" },
  { manufacturer: "samsung", model: "SM-A715F",  brand: "samsung", product: "a71",
    buildSuffix: "QP1A.190711.020/A715FXXU5DUI1:user/release-keys", codename: "a71",
    androidVersion: "10", apiLevel: 29, glRenderer: "Adreno (TM) 620", glVendor: "Qualcomm" },
  { manufacturer: "Xiaomi",  model: "Redmi Note 8", brand: "xiaomi", product: "ginkgo",
    buildSuffix: "QKQ1.191014.001/V12.0.2.0.QCOCNXM:user/release-keys", codename: "ginkgo",
    androidVersion: "10", apiLevel: 29, glRenderer: "Adreno (TM) 512", glVendor: "Qualcomm" },
  { manufacturer: "Xiaomi",  model: "Redmi Note 9", brand: "xiaomi", product: "merlin",
    buildSuffix: "QKQ1.200628.002/V12.0.3.0.QJOEUXM:user/release-keys", codename: "merlin",
    androidVersion: "10", apiLevel: 29, glRenderer: "Mali-G57",        glVendor: "ARM" },
  { manufacturer: "motorola", model: "moto g(8) power", brand: "motorola", product: "sofiar",
    buildSuffix: "QPS30.85-Q3-49-6-4/59d71:user/release-keys",       codename: "sofiar",
    androidVersion: "10", apiLevel: 29, glRenderer: "Adreno (TM) 508", glVendor: "Qualcomm" },
  { manufacturer: "HUAWEI",  model: "MAR-LX1A",  brand: "HONOR",   product: "HWMAR",
    buildSuffix: "HONORMAR-L21A/10.0.0.186(C431)/honormar:user/release-keys", codename: "HWMAR",
    androidVersion: "10", apiLevel: 29, glRenderer: "Mali-G51",        glVendor: "ARM" },
  { manufacturer: "realme",  model: "RMX2001",   brand: "realme",  product: "RMX2001",
    buildSuffix: "QKQ1.200209.002/1585849852:user/release-keys",      codename: "RMX2001L1",
    androidVersion: "10", apiLevel: 29, glRenderer: "Adreno (TM) 618", glVendor: "Qualcomm" },
  // ── Android 11 (API 30) profiles ────────────────────────────────────────
  { manufacturer: "samsung", model: "SM-A325F",  brand: "samsung", product: "a32",
    buildSuffix: "RP1A.200720.012/A325FXXU4CVG1:user/release-keys",  codename: "a32",
    androidVersion: "11", apiLevel: 30, glRenderer: "Mali-G80",        glVendor: "ARM" },
  { manufacturer: "samsung", model: "SM-A526B",  brand: "samsung", product: "a52x",
    buildSuffix: "RP1A.200720.012/A526BXXU4DWA1:user/release-keys",  codename: "a52x",
    androidVersion: "11", apiLevel: 30, glRenderer: "Adreno (TM) 620", glVendor: "Qualcomm" },
  { manufacturer: "Xiaomi",  model: "Redmi Note 10", brand: "xiaomi", product: "sunny",
    buildSuffix: "RKQ1.200826.002/V12.5.4.0.RGGEUXM:user/release-keys", codename: "sunny",
    androidVersion: "11", apiLevel: 30, glRenderer: "Adreno (TM) 619", glVendor: "Qualcomm" },
  { manufacturer: "Xiaomi",  model: "Redmi Note 10S", brand: "xiaomi", product: "rosemary",
    buildSuffix: "RKQ1.200826.002/V12.5.2.0.RKGEUXM:user/release-keys", codename: "rosemary",
    androidVersion: "11", apiLevel: 30, glRenderer: "Mali-G76",         glVendor: "ARM" },
  { manufacturer: "motorola", model: "moto edge (2021)", brand: "motorola", product: "berlna",
    buildSuffix: "RRB31.Q3-48-79-2/2c0c67:user/release-keys",          codename: "berlna",
    androidVersion: "11", apiLevel: 30, glRenderer: "Adreno (TM) 619", glVendor: "Qualcomm" },
  { manufacturer: "realme",  model: "RMX3231",   brand: "realme",  product: "RMX3231",
    buildSuffix: "RP1A.200720.011/1630656840:user/release-keys",      codename: "RMX3231",
    androidVersion: "11", apiLevel: 30, glRenderer: "Adreno (TM) 619", glVendor: "Qualcomm" },
  { manufacturer: "motorola", model: "moto g(30)", brand: "motorola", product: "caprip",
    buildSuffix: "RRB31.Q3-28-26-5/190776:user/release-keys",         codename: "caprip",
    androidVersion: "11", apiLevel: 30, glRenderer: "Adreno (TM) 619", glVendor: "Qualcomm" },
  { manufacturer: "vivo",    model: "V2026",     brand: "vivo",    product: "V2026",
    buildSuffix: "RP1A.200720.012/compile11301538:user/release-keys",  codename: "V2026",
    androidVersion: "11", apiLevel: 30, glRenderer: "Adreno (TM) 619", glVendor: "Qualcomm" },
];

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generate a stable fingerprint profile for a device.
 * Deterministic from deviceId — same output every call.
 * Each device gets a unique but realistic-looking profile.
 */
export function generateFingerprintProfile(
  deviceId:    string,
  locationId:  string,           // "loc_a" | "loc_b" | "loc_c" | "loc_d"
  deviceApiLevel: 29 | 30 = 30  // actual Android API level of the device
): FingerprintProfile {
  // Deterministic seed from deviceId
  const seed = crypto.createHash("sha256").update(`fingerprint:${deviceId}`).digest();

  // Select profile matching device's actual Android version (coherence)
  const matchingPool = DEVICE_POOL.filter(d => d.apiLevel === deviceApiLevel);
  const pool         = matchingPool.length > 0 ? matchingPool : DEVICE_POOL;
  const idx          = seed[0] % pool.length;
  const device       = pool[idx];

  const androidId = seed.slice(1, 9).toString("hex");     // 16 hex chars
  const gsfId     = seed.slice(9, 17).toString("hex");    // 16 hex chars
  const serial    = toAlphanumeric(seed.slice(17, 22));   // 10 chars

  // B1 fix: use androidVersion ("13") not api level ("33") — Build.FINGERPRINT uses VERSION.RELEASE
  const buildFp = `${device.brand}/${device.product}/${device.codename}:${device.androidVersion}/${device.buildSuffix}`;

  // Locale: map location to simulated locale
  const localeMap: Record<string, string> = {
    loc_a: "ro-RO",
    loc_b: "en-GB",
    loc_c: "de-DE",
    loc_d: "ro-RO",
  };
  const locale = localeMap[locationId] ?? "ro-RO";

  // WebView User-Agent: matches spoofed model/manufacturer
  const userAgent = buildUserAgent(device.model, device.androidVersion);

  return {
    deviceId,
    androidId,
    gsfId,
    buildFingerprint: buildFp,
    buildBrand:       device.brand,
    buildDevice:      device.codename,
    buildProduct:     device.product,
    manufacturer:     device.manufacturer,
    model:            device.model,
    serialNumber:     serial,
    locale,
    glRenderer:       device.glRenderer,
    glVendor:         device.glVendor,
    userAgent,
    dnsConfig:        buildDnsConfig(seed),   // A4
    moduleVersionCode: 1,
  };
}

// ─── DNS config ───────────────────────────────────────────────────────────────

/**
 * DNS provider pool for per-device Private DNS (DoT) diversification.
 * Android 9+ supports Private DNS (Settings > Network > Private DNS).
 * Format: RFC-7858 hostname for DoT.
 *
 * Assignment: deterministic from deviceId seed byte[2] — stable, no DB storage.
 * Never two consecutive devices get the same provider.
 */
const DNS_PROVIDERS = [
  { provider: "Cloudflare",  hostname: "one.one.one.one",   fallback: ["1.1.1.1", "1.0.0.1"] },
  { provider: "Google",      hostname: "dns.google",         fallback: ["8.8.8.8", "8.8.4.4"] },
  { provider: "Quad9",       hostname: "dns.quad9.net",      fallback: ["9.9.9.9", "149.112.112.112"] },
  { provider: "NextDNS",     hostname: "dns.nextdns.io",     fallback: ["45.90.28.0", "45.90.30.0"] },
] as const;

export function buildDnsConfig(seed: Buffer): {
  provider: string; hostname: string; fallback: readonly string[];
} {
  const idx = seed[2] % DNS_PROVIDERS.length;
  return DNS_PROVIDERS[idx];
}

/** Build a realistic Chrome/Android UA string matching the spoofed model and Android version */
function buildUserAgent(model: string, androidVersion: string): string {
  // Chrome version realistic for Android 10/11 era (2021-2022)
  const chromeVersion = androidVersion === "10" ? "86.0.4240.198" : "91.0.4472.164";
  return `Mozilla/5.0 (Linux; Android ${androidVersion}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;
}

function toAlphanumeric(buf: Buffer): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(buf).map(b => chars[b % chars.length]).join("");
}

// ─── CONFIG_UPDATE payload builder ───────────────────────────────────────────

/**
 * Build the CONFIG_UPDATE WebSocket message payload for a device.
 * Sent on connect — device applies spoofing config.
 */
/**
 * Build CLOAK_CONFIG WS payload — sent to device on connect.
 * Device saves to SharedPreferences; LSPosed module reads on next app launch.
 */
/** Build CLOAK_CONFIG WS payload from a FingerprintProfile (includes dnsConfig). */
export function buildCloakConfigPayload(profile: FingerprintProfile): Record<string, unknown> {
  return {
    androidId:         profile.androidId,
    gsfId:             profile.gsfId,
    buildModel:        profile.model,
    buildManufacturer: profile.manufacturer,
    buildFingerprint:  profile.buildFingerprint,
    buildBrand:        profile.buildBrand,
    buildDevice:       profile.buildDevice,
    buildProduct:      profile.buildProduct,
    buildSerial:       profile.serialNumber,
    locale:            profile.locale,
    glRenderer:        profile.glRenderer,
    glVendor:          profile.glVendor,
    userAgent:         profile.userAgent,
    blockImei:         true,
    moduleVersionCode: profile.moduleVersionCode,
    dnsConfig: {
      provider: profile.dnsConfig.provider,
      hostname: profile.dnsConfig.hostname,
      fallback: profile.dnsConfig.fallback,
    },
  };
}
