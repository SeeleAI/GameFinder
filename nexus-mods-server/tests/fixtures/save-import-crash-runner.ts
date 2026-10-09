import { GenericSaveImportService } from "../../src/save/generic/import-service.js";
const [managerRoot, planId, checkpoint, mode] = process.argv.slice(2);
if (!managerRoot || !planId || !checkpoint) throw new Error("Missing crash fixture arguments");
const service = await GenericSaveImportService.create({ managerRoot, processGuard: async () => undefined,
  checkpoint: async (name) => { if (name === checkpoint) process.exit(86); } });
if (mode === "restore") await service.restore(planId); else await service.apply(planId);
throw new Error("Expected injected process exit did not occur");
