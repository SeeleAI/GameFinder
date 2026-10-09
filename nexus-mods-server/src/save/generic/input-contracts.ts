import { z } from "zod/v4";
const schemaVersion = z.literal(1);
const relativePath = z.string().min(1);
const absolutePath = z.string().min(3);
const identifier = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string();
export const saveInputEntrySchema = z.object({
  originalPath: relativePath,
  normalizedPath: relativePath,
  kind: z.enum(["file", "directory"]),
  bytes: z.number().int().nonnegative(),
  packedBytes: z.number().int().nonnegative().nullable(),
  crc32: z.string().regex(/^[A-Fa-f0-9]{8}$/).nullable(),
});

export const saveInputInspectionSchema = z.object({
  schemaVersion,
  inspectionId: z.string().uuid(),
  input: z.object({
    kind: z.enum(["file", "directory", "zip", "rar", "7z"]),
    absolutePath,
    bytes: z.number().int().nonnegative(),
    sha256,
    modifiedAt: timestamp,
  }),
  archive: z
    .object({
      format: z.enum(["zip", "rar", "7z"]),
      extractor: z
        .object({
          kind: z.enum(["builtin-zip", "unrar", "seven-zip", "bsdtar"]),
          executablePath: absolutePath.nullable(),
          version: identifier,
        })
        .nullable(),
      entries: z.array(saveInputEntrySchema).max(100_000),
      totalUncompressedBytes: z.number().int().nonnegative(),
      totalPackedBytes: z.number().int().nonnegative().nullable(),
      commonTopLevelDirectory: relativePath.nullable(),
    })
    .nullable(),
  entries: z.array(saveInputEntrySchema).min(1).max(100_000),
  containsExecutable: z.boolean(),
  warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  createdAt: timestamp,
  inspectionHash: sha256,
});

export type SaveInputInspection = z.infer<typeof saveInputInspectionSchema>;
