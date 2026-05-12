/**
 * middleware/upload.ts
 * Single-file upload middleware reusing multer (already a dependency).
 */
import multer from "multer";
import path from "path";
import fs from "fs";

/**
 * Returns a middleware that accepts a single file upload for the given field name.
 * Saves to destDir with original filename.
 */
export function multerSingle(fieldName: string, destDir: string) {
  // Ensure dest exists synchronously at middleware creation time
  fs.mkdirSync(destDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req: any, _file: any, cb: (error: Error | null, destination: string) => void) => {
      cb(null, destDir);
    },
    filename: (_req: any, file: any, cb: (error: Error | null, filename: string) => void) => {
      cb(null, file.originalname || "phone-network.apk");
    },
  });

  return multer({
    storage,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req: any, file: any, cb: any) => {
      if (file.originalname.endsWith(".apk")) {
        cb(null, true);
      } else {
        cb(new Error("Only .apk files allowed"));
      }
    },
  }).single(fieldName);
}
