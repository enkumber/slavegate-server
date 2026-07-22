import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activeOtaApkPath,
  inspectOtaApk,
  publishOtaApk,
  readActiveOtaRelease,
} from "./apk-release";

const bundledApk = path.join(process.cwd(), "apk", "phone-network.apk");
let bundledMetadata: Awaited<ReturnType<typeof inspectOtaApk>>;
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-network-ota-"));
  tempDirs.push(dir);
  return dir;
}

async function seedRelease(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await fs.copyFile(bundledApk, path.join(dir, "phone-network.apk"));
  await fs.writeFile(
    path.join(dir, "phone-network.json"),
    JSON.stringify({ ...bundledMetadata, filename: "phone-network.apk", ...overrides }),
  );
}

describe("atomic OTA APK releases", () => {
  beforeAll(async () => {
    bundledMetadata = await inspectOtaApk(bundledApk);
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("extracts authoritative package and version metadata from the APK", () => {
    expect(bundledMetadata).toMatchObject({
      packageName: "com.phonenetwork",
      version: "4.0.61",
      versionCode: 117,
    });
    expect(bundledMetadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundledMetadata.size).toBeGreaterThan(0);
  });

  it("refuses an active release whose JSON metadata disagrees with its APK", async () => {
    const dir = await tempDir();
    await seedRelease(dir, { version: "4.0.51", versionCode: 107 });

    await expect(readActiveOtaRelease(dir)).rejects.toThrow(
      "OTA metadata mismatch: manifest=4.0.51/107 apk=4.0.61/117",
    );
  });

  it("publishes an immutable APK and atomically switches matching metadata", async () => {
    const dir = await tempDir();
    const staged = path.join(dir, "incoming.apk");
    await fs.copyFile(bundledApk, staged);

    const release = await publishOtaApk(dir, staged);
    const active = await readActiveOtaRelease(dir);

    expect(active).toEqual(release);
    expect(active.filename).toBe(`phone-network-${bundledMetadata.sha256}.apk`);
    expect(await fs.readFile(path.join(dir, "phone-network.json"), "utf8")).toContain('"versionCode": 117');
    expect(await fs.stat(activeOtaApkPath(dir, active))).toMatchObject({ size: bundledMetadata.size });
    await expect(fs.access(staged)).rejects.toThrow();
  });

  it("refuses a manifest that points outside the OTA directory", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "phone-network.json"),
      JSON.stringify({ ...bundledMetadata, filename: "../phone-network.apk" }),
    );

    await expect(readActiveOtaRelease(dir)).rejects.toThrow("invalid APK filename");
  });

  it("keeps the published APK hash equal to the manifest hash", async () => {
    const dir = await tempDir();
    const staged = path.join(dir, "incoming.apk");
    await fs.copyFile(bundledApk, staged);
    const release = await publishOtaApk(dir, staged);
    const bytes = await fs.readFile(activeOtaApkPath(dir, release));

    expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(release.sha256);
  });
});
