import type { GameSaveRecipeRegistryV2 } from "../recipes/recipe-registry.js";
import type {
  GameInstallContextV2,
  GameSaveRecipe,
  SaveDistributionKind,
} from "../v2/contracts.js";

export interface PeMetadata {
  productName: string | null;
  fileDescription: string | null;
  fileVersion: string | null;
  productVersion: string | null;
}

export type PeMetadataReader = (executablePath: string) => Promise<PeMetadata | null>;

export interface SaveInstallResolverInput {
  gameRoot: string;
  recipes: GameSaveRecipeRegistryV2;
  recipeId?: string;
  now?: Date;
  peMetadataReader?: PeMetadataReader;
}

export interface SaveInstallResolverV2 {
  readonly resolverId: string;
  readonly resolverVersion: string;
  readonly distributionKind: SaveDistributionKind;
  probe(input: SaveInstallResolverInput): Promise<GameInstallContextV2 | null>;
}

export interface VerifiedRecipeAnchor {
  recipe: Readonly<GameSaveRecipe>;
  anchorPath: string;
  anchorSha256: string;
  peMetadata: PeMetadata | null;
}
