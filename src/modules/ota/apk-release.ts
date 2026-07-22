import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

type ParsedApkManifest = {
  package?: unknown;
  versionCode?: unknown;
  versionName?: unknown;
};

type ApkReaderInstance = {
  readManifest(): Promise<ParsedApkManifest>;
};

type ApkReaderModule = {
  open(filePath: string): Promise<ApkReaderInstance>;
};

// The package does not ship TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ApkReader = require("@devicefarmer/adbkit-apkreader") as ApkReaderModule;

const OTA_PACKAGE_NAME = "com.phonenetwork";
const ACTIVE_MANIFEST_NAME = "phone-network.json";

export type OtaApkMetadata = {
  packageName: string;
  version: string;
  versionCode: number;
  sha256: string;
  size: number;
};

export type OtaReleaseManifest = OtaApkMetadata & {
  filename: string;
};

function assertSafeApkFilename(filename: unknown): asserts filename is string {
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    filename !== path.basename(filename) ||
    !filename.endsWith(".apk")
  ) {
    throw new Error("OTA manifest contains an invalid APK filename");
  }
}

function manifestPath(apkDir: string): string {
  return path.join(apkDir, ACTIVE_MANIFEST_NAME);
}

async function sha256File(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function inspectOtaApk(filePath: string): Promise<OtaApkMetadata> {
  const reader = await ApkReader.open(filePath);
  const manifest = await reader.readManifest();
  const packageName = manifest.package;
  const version = manifest.versionName;
  const versionCode = manifest.versionCode;

  if (packageName !== OTA_PACKAGE_NAME) {
    throw new Error(`OTA APK package must be ${OTA_PACKAGE_NAME}; received ${String(packageName)}`);
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("OTA APK has no valid versionName");
  }
  if (!Number.isSafeInteger(versionCode) || Number(versionCode) <= 0) {
    throw new Error(`OTA APK has invalid versionCode ${String(versionCode)}`);
  }

  const stat = await fs.stat(filePath);
  return {
    packageName,
    version: version.trim(),
    versionCode: Number(versionCode),
    sha256: await sha256File(filePath),
    size: stat.size,
  };
}

export async function readActiveOtaRelease(apkDir: string): Promise<OtaReleaseManifest> {
  const raw = JSON.parse(await fs.readFile(manifestPath(apkDir), "utf8")) as Record<string, unknown>;
  assertSafeApkFilename(raw.filename);

  const apkPath = path.join(apkDir, raw.filename);
  const actual = await inspectOtaApk(apkPath);
  const expectedVersion = raw.version;
  const expectedVersionCode = raw.versionCode;
  const expectedSha256 = raw.sha256;
  const expectedSize = raw.size;

  if (expectedVersion !== actual.version || expectedVersionCode !== actual.versionCode) {
    throw new Error(
      `OTA metadata mismatch: manifest=${String(expectedVersion)}/${String(expectedVersionCode)} ` +
      `apk=${actual.version}/${actual.versionCode}`,
    );
  }
  if (expectedSha256 !== actual.sha256) {
    throw new Error(
      `OTA SHA256 mismatch: manifest=${String(expectedSha256).slice(0, 16)} apk=${actual.sha256.slice(0, 16)}`,
    );
  }
  if (expectedSize !== actual.size) {
    throw new Error(`OTA size mismatch: manifest=${String(expectedSize)} apk=${actual.size}`);
  }

  return { ...actual, filename: raw.filename };
}

export function activeOtaApkPath(apkDir: string, release: OtaReleaseManifest): string {
  assertSafeApkFilename(release.filename);
  return path.join(apkDir, release.filename);
}

/**
 * Publish an immutable APK and switch the active manifest with one atomic rename.
 * Readers either see the previous complete release or the new complete release.
 */
export async function publishOtaApk(apkDir: string, stagedApkPath: string): Promise<OtaReleaseManifest> {
  await fs.mkdir(apkDir, { recursive: true });
  const metadata = await inspectOtaApk(stagedApkPath);
  const filename = `phone-network-${metadata.sha256}.apk`;
  const finalApkPath = path.join(apkDir, filename);
  const tempApkPath = `${finalApkPath}.tmp-${process.pid}-${Date.now()}`;
  const tempManifestPath = `${manifestPath(apkDir)}.tmp-${process.pid}-${Date.now()}`;
  const release: OtaReleaseManifest = { ...metadata, filename };

  try {
    try {
      await fs.access(finalApkPath);
    } catch {
      await fs.copyFile(stagedApkPath, tempApkPath);
      const copied = await inspectOtaApk(tempApkPath);
      if (copied.sha256 !== metadata.sha256) {
        throw new Error("OTA staged APK changed while being published");
      }
      await fs.rename(tempApkPath, finalApkPath);
    }

    const publishedApk = await inspectOtaApk(finalApkPath);
    if (publishedApk.sha256 !== metadata.sha256) {
      throw new Error("Existing immutable OTA APK does not match its content-addressed filename");
    }

    await fs.writeFile(tempManifestPath, `${JSON.stringify(release, null, 2)}\n`, { mode: 0o644 });
    await fs.rename(tempManifestPath, manifestPath(apkDir));
    return await readActiveOtaRelease(apkDir);
  } finally {
    await Promise.allSettled([
      fs.rm(stagedApkPath, { force: true }),
      fs.rm(tempApkPath, { force: true }),
      fs.rm(tempManifestPath, { force: true }),
    ]);
  }
}
