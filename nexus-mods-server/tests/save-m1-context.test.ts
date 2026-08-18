import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SaveService } from "../src/save/save-service.js";

const STEAM_ID = "76561198127396738";
const temporaryDirectories: string[] = [];

interface SteamFixture {
  managerRoot: string;
  gameRoot: string;
  appData: string;
  saveRoot: string;
}

async function createSteamFixture(options: {
  lastOwner?: string | null;
  createSave?: boolean;
} = {}): Promise<SteamFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-m1-"));
  temporaryDirectories.push(root);
  const steamApps = path.join(root, "Steam", "steamapps");
  const gameRoot = path.join(
    steamApps,
    "common",
    "ELDEN RING",
    "Game",
  );
  const appData = path.join(root, "User", "AppData", "Roaming");
  const saveRoot = path.join(appData, "EldenRing", STEAM_ID);
  const managerRoot = path.join(root, "manager");
  await Promise.all([
    mkdir(gameRoot, { recursive: true }),
    mkdir(managerRoot, { recursive: true }),
    mkdir(path.join(appData, "EldenRing"), { recursive: true }),
  ]);
  await writeFile(path.join(gameRoot, "eldenring.exe"), "fixture");
  const lastOwner =
    options.lastOwner === undefined ? STEAM_ID : options.lastOwner;
  await writeFile(
    path.join(steamApps, "appmanifest_1245620.acf"),
    `"AppState"
{
  "appid" "1245620"
  "name" "ELDEN RING"
  "installdir" "ELDEN RING"
  "buildid" "22984413"
  ${lastOwner ? `"LastOwner" "${lastOwner}"` : ""}
}
`,
  );
  if (options.createSave ?? true) {
    await mkdir(saveRoot, { recursive: true });
    await writeFile(path.join(saveRoot, "ER0000.sl2"), "save");
    await writeFile(path.join(saveRoot, "ER0000.sl2.bak"), "backup");
    await writeFile(path.join(saveRoot, "steam_autocloud.vdf"), "cloud");
    await writeFile(
      path.join(appData, "EldenRing", "GraphicsConfig.xml"),
      "config",
    );
  }
  return { managerRoot, gameRoot, appData, saveRoot };
}

function serviceFor(fixture: SteamFixture, profiles?: []) {
  return SaveService.create({
    managerRoot: fixture.managerRoot,
    environment: {
      platform: "win32",
      appData: fixture.appData,
      localAppData: path.join(
        path.dirname(fixture.appData),
        "Local",
      ),
      userProfile: path.join(fixture.appData, "..", ".."),
      username: "fixture",
    },
    ...(profiles === undefined ? {} : { profiles }),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("save M1 Steam and Elden Ring discovery", () => {
  it("resolves gameRoot to a confirmed Elden Ring Save Context", async () => {
    const fixture = await createSteamFixture();
    const service = await serviceFor(fixture);
    const install = await service.probeGameInstall({
      gameRoot: fixture.gameRoot,
    });
    expect(install).toMatchObject({
      platform: "windows",
      store: "steam",
      game: {
        canonicalId: "steam:1245620",
        storeAppId: "1245620",
      },
      storeMetadata: {
        steam: {
          buildId: "22984413",
          lastOwner: STEAM_ID,
        },
      },
      confidence: "confirmed",
    });

    const context = await service.resolveSaveLocations(
      install.installContextId,
    );
    expect(context).toMatchObject({
      installContextId: install.installContextId,
      storeAccount: { kind: "steam_id64", value: STEAM_ID },
      saveRoots: [
        {
          rootId: "primary",
          absolutePath: fixture.saveRoot,
          role: "primary",
        },
      ],
      verification: {
        state: "confirmed",
        method: "profile+filesystem",
      },
      format: {
        kind: "game-specific-container",
        adapterId: "elden-ring-steam-pc",
      },
    });
    expect(context.saveUnits[0]?.managedPaths).toEqual([
      "ER0000.sl2",
      "ER0000.sl2.bak",
      "steam_autocloud.vdf",
    ]);
    expect(
      context.saveUnits.flatMap((unit) => unit.managedPaths),
    ).not.toContain("GraphicsConfig.xml");
    expect(await service.getSaveContext(context.saveContextId)).toEqual(
      context,
    );
  });

  it("rejects an install root whose executable anchor is missing", async () => {
    const fixture = await createSteamFixture();
    await rm(path.join(fixture.gameRoot, "eldenring.exe"));
    const service = await serviceFor(fixture);
    await expect(
      service.probeGameInstall({ gameRoot: fixture.gameRoot }),
    ).rejects.toMatchObject({
      code: "GAME_INSTALL_NOT_IDENTIFIED",
    });
  });

  it("reports ambiguous save roots when LastOwner is unavailable", async () => {
    const fixture = await createSteamFixture({
      lastOwner: null,
      createSave: false,
    });
    for (const steamId of [STEAM_ID, "76561198000000000"]) {
      const root = path.join(fixture.appData, "EldenRing", steamId);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "ER0000.sl2"), steamId);
    }
    const service = await serviceFor(fixture);
    const install = await service.probeGameInstall({
      gameRoot: fixture.gameRoot,
    });
    await expect(
      service.resolveSaveLocations(install.installContextId),
    ).rejects.toMatchObject({
      code: "SAVE_CONTEXT_AMBIGUOUS",
    });
  });

  it("learns a unique save root from a bounded differential probe", async () => {
    const fixture = await createSteamFixture({ createSave: false });
    const service = await serviceFor(fixture);
    const install = await service.probeGameInstall({
      gameRoot: fixture.gameRoot,
    });
    await expect(
      service.resolveSaveLocations(install.installContextId),
    ).rejects.toMatchObject({ code: "SAVE_CONTEXT_NOT_FOUND" });

    const started = await service.beginSaveLocationProbe(
      install.installContextId,
    );
    await mkdir(fixture.saveRoot, { recursive: true });
    await writeFile(path.join(fixture.saveRoot, "ER0000.sl2"), "new-save");
    const completed = await service.completeSaveLocationProbe(
      started.probeId,
    );
    expect(completed.probe.status).toBe("completed");
    expect(completed.probe.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: `${STEAM_ID}/ER0000.sl2`,
          kind: "created",
        }),
      ]),
    );
    expect(completed.learnedProfile).toMatchObject({
      gameCanonicalId: "steam:1245620",
      saveRoot: fixture.saveRoot,
      observedRelativePaths: ["ER0000.sl2"],
      state: "local_verified",
    });
    expect(completed.saveContext).toMatchObject({
      verification: {
        state: "confirmed",
        method: "differential-probe",
      },
    });

    const learnedFiles = await readdir(
      path.join(
        fixture.managerRoot,
        "save-manager",
        "learned-profiles",
      ),
    );
    expect(learnedFiles).toHaveLength(1);

    const learnedOnlyService = await serviceFor(fixture, []);
    const learnedContext =
      await learnedOnlyService.resolveSaveLocations(
        install.installContextId,
      );
    expect(learnedContext.verification.method).toBe("learned-profile");
    expect(learnedContext.saveRoots[0]?.absolutePath).toBe(
      fixture.saveRoot,
    );
  });
});
