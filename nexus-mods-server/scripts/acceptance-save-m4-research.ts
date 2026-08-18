import path from "node:path";

import { NexusClient } from "../src/nexus-client.js";
import {
  resolveDefaultSaveManagerRoot,
  SaveService,
} from "../src/save/save-service.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1]?.trim() || null;
}

async function main(): Promise<void> {
  const installContextId = argument("--install-context-id");
  const configuredManagerRoot = argument("--manager-root");
  if (!installContextId) {
    throw new Error(
      "Usage: pnpm acceptance:save-m4-research -- --install-context-id <uuid> [--manager-root <absolute-path>]",
    );
  }
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }
  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const nexus = new NexusClient();
  const service = await SaveService.create({ managerRoot, nexusClient: nexus });
  const result = await service.researchNexusSaveSources({
    installContextId,
    query: "Base Game and DLC 100 Percent Complete Save File",
    maxCandidates: 20,
  });
  const baseline = result.candidates.find(
    (candidate) =>
      candidate.selection.kind === "nexus" &&
      candidate.selection.modId === 6732 &&
      candidate.selection.fileId === 46818,
  );
  const recommended = baseline ?? result.candidates[0] ?? null;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        acceptanceChecked: "ER-06-source",
        snapshot: result.snapshot,
        exactBaselineStillAvailable: baseline !== undefined,
        recommended,
        candidates: result.candidates,
        writesToGameOrSaveFiles: false,
        nextAction: recommended
          ? "Review the exact candidate. Prepare and download its frozen Nexus file, then bind the Nexus receipt and normalize the downloaded save."
          : "No eligible MAIN/primary candidate remains; refresh with broader completion queries and record the replacement reason.",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown acceptance error";
  console.error(`M4 Nexus save research failed: ${message}`);
  process.exitCode = 1;
});
