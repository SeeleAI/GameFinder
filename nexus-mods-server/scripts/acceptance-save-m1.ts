import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SaveService } from "../src/save/save-service.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1]?.trim();
  return value || null;
}

async function main(): Promise<void> {
  const gameRoot = argument("--game-root");
  if (!gameRoot || !path.isAbsolute(gameRoot)) {
    throw new Error(
      "Usage: pnpm acceptance:save-m1 -- --game-root <absolute-path> [--manager-root <absolute-path>]",
    );
  }
  const configuredManagerRoot = argument("--manager-root");
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }
  const temporaryPrefix = path.join(
    os.tmpdir(),
    "gamefinder-save-m1-acceptance-",
  );
  const managerRoot =
    configuredManagerRoot ?? (await mkdtemp(temporaryPrefix));
  const ownsManagerRoot = configuredManagerRoot === null;
  try {
    const service = await SaveService.create({ managerRoot });
    const install = await service.probeGameInstall({ gameRoot });
    const save = await service.resolveSaveLocations(
      install.installContextId,
    );
    if (install.game.canonicalId !== "steam:1245620") {
      throw new Error(
        `Expected steam:1245620, received ${install.game.canonicalId}.`,
      );
    }
    if (save.verification.state !== "confirmed") {
      throw new Error(
        `Expected a confirmed Save Context, received ${save.verification.state}.`,
      );
    }
    const managedPaths = save.saveUnits.flatMap(
      (unit) => unit.managedPaths,
    );
    if (
      !managedPaths.includes("ER0000.sl2") ||
      managedPaths.includes("GraphicsConfig.xml")
    ) {
      throw new Error(
        "The Elden Ring managed-path boundary does not match the M1 contract.",
      );
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          acceptance: "ER-01",
          installContext: {
            installContextId: install.installContextId,
            contextHash: install.contextHash,
            gameRoot: install.gameRoot,
            game: install.game,
            steam: install.storeMetadata.steam,
            confidence: install.confidence,
          },
          saveContext: {
            saveContextId: save.saveContextId,
            contextHash: save.contextHash,
            saveRoots: save.saveRoots,
            saveUnits: save.saveUnits,
            format: save.format,
            verification: save.verification,
          },
          writesToGameOrSaveFiles: false,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (ownsManagerRoot) {
      const resolved = path.resolve(managerRoot);
      const expectedParent = path.resolve(os.tmpdir());
      if (
        path.dirname(resolved) !== expectedParent ||
        !path.basename(resolved).startsWith(
          "gamefinder-save-m1-acceptance-",
        )
      ) {
        throw new Error(
          "Refusing to clean a manager root that is not the acceptance temp directory.",
        );
      }
      await rm(resolved, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown acceptance error";
  console.error(`M1 save acceptance failed: ${message}`);
  process.exitCode = 1;
});
