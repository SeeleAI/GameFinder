import type { AdapterRequirementAssessment, GameSaveRecipe } from "../v2/contracts.js";
import { analyzeGhostOfTsushimaPcV49 } from "./ghost-of-tsushima-pc-v49.js";

type AdapterIntendedOperation = AdapterRequirementAssessment["intendedOperation"];

export interface FormatAdapterDescriptor {
  adapterId: string;
  adapterVersion: string;
  recipeIds: ReadonlyArray<string>;
  formatKinds: ReadonlyArray<GameSaveRecipe["format"]["kind"]>;
  operations: ReadonlyArray<AdapterIntendedOperation>;
  capabilities: ReadonlyArray<string>;
  validateBytes?: (bytes: Uint8Array) => { valid: boolean; detail: string };
}

const BUILT_IN_FORMAT_ADAPTERS: ReadonlyArray<FormatAdapterDescriptor> = [
  {
    adapterId: "elden-ring-steam-pc",
    adapterVersion: "1.0.0",
    recipeIds: ["elden-ring-windows"],
    formatKinds: ["game-specific-container"],
    operations: ["import-container-slot", "cross-account-import"],
    capabilities: ["container-parse", "slot-transform", "account-rebind", "checksum-verification", "container-rebuild"],
  },
  {
    adapterId: "ghost-of-tsushima-pc-v49",
    adapterVersion: "1.0.0",
    recipeIds: ["ghost-of-tsushima-directors-cut-windows"],
    formatKinds: ["game-specific-container"],
    operations: ["replace-whole-unit", "import-slot-file", "cross-account-import"],
    capabilities: ["pc-v49-parse", "content-size-verification", "platform-marker-verification", "checksum-verification", "account-neutral-exact-file-replacement"],
    validateBytes: (bytes) => {
      const analysis = analyzeGhostOfTsushimaPcV49(bytes);
      return {
        valid: analysis.valid,
        detail: analysis.valid
          ? `PC v49 structure valid; contentSize=${analysis.contentSize}, checksum=0x${analysis.checksum.toString(16).padStart(8, "0")}, build/platform/PC markers matched.`
          : `PC v49 validation failed: ${analysis.errors.join(", ")}.`,
      };
    },
  },
];

export class FormatAdapterRegistry {
  constructor(private readonly descriptors: ReadonlyArray<FormatAdapterDescriptor> = BUILT_IN_FORMAT_ADAPTERS) {}

  list(): ReadonlyArray<FormatAdapterDescriptor> {
    return this.descriptors.map((descriptor) => ({ ...descriptor }));
  }

  match(input: {
    adapterId: string | null;
    recipe: Readonly<GameSaveRecipe>;
    operation: AdapterIntendedOperation;
  }): Readonly<FormatAdapterDescriptor> | null {
    if (!input.adapterId) return null;
    return this.descriptors.find((descriptor) => (
      descriptor.adapterId === input.adapterId &&
      descriptor.recipeIds.includes(input.recipe.recipeId) &&
      descriptor.formatKinds.includes(input.recipe.format.kind) &&
      descriptor.operations.includes(input.operation)
    )) ?? null;
  }
}
