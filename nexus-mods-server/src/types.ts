export interface QuotaSnapshot {
  dailyLimit: number | null;
  dailyRemaining: number | null;
  hourlyLimit: number | null;
  hourlyRemaining: number | null;
}

export interface ResponseMeta {
  source: "nexus-rest-v1" | "nexus-graphql-v2" | "local";
  fetchedAt: string;
  cache: "miss" | "hit" | "bypass";
  quota: QuotaSnapshot | null;
  warnings: string[];
}

export interface NexusGame {
  id: number;
  name: string;
  domainName: string;
  approvedDate?: number;
  authors?: number;
  mods?: number;
  downloads?: number;
  fileCount?: number;
}

export interface NexusMod {
  modId: number;
  name: string;
  summary: string;
  description: string;
  version: string;
  author: string;
  uploadedBy: string;
  domainName: string;
  categoryId: number;
  containsAdultContent: boolean;
  status: string;
  available: boolean;
  totalDownloads: number;
  uniqueDownloads: number;
  endorsements: number;
  createdAt: string | null;
  updatedAt: string | null;
  pictureUrl: string | null;
  canonicalUrl: string;
}

export interface NexusModFile {
  fileId: number;
  name: string;
  version: string;
  categoryId: number;
  categoryName: string;
  fileName: string;
  sizeKb: number;
  sizeInBytes: number | null;
  uploadedAt: string | null;
  isPrimary: boolean;
  description: string;
  contentPreviewLink: string | null;
}

export interface DiscoveredMod {
  modId: number;
  name: string;
  summary: string;
  author: string;
  version: string;
  status: string;
  domainName: string;
  totalDownloads: number;
  endorsements: number;
  createdAt: string | null;
  updatedAt: string | null;
  canonicalUrl: string;
}

export interface ModRequirement {
  id: string;
  modId: string;
  modName: string;
  gameId: string;
  url: string;
  notes: string | null;
  externalRequirement: boolean;
}

export interface ModRequirements {
  dlcRequirements: Array<{
    id: string;
    gameId: string;
    name: string;
    notes: string | null;
  }>;
  nexusRequirements: ModRequirement[];
  modsRequiringThisMod: ModRequirement[];
  counts: {
    nexusRequirements: number;
    modsRequiringThisMod: number;
  };
}

export interface DownloadLink {
  name: string;
  shortName: string;
  uri: string;
}
