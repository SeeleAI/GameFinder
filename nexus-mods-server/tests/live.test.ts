import { describe, expect, it } from "vitest";
import { NexusClient } from "../src/nexus-client.js";

const liveEnabled = process.env.NEXUS_RUN_LIVE_TESTS === "true" && Boolean(process.env.NEXUS_API_KEY);

describe.skipIf(!liveEnabled)("live Nexus API", () => {
  it("validates credentials and verifies the acceptance mod", async () => {
    const client = new NexusClient();
    const validation = await client.validateCredentials();
    expect(validation.valid).toBe(true);

    const { mod } = await client.getMod("eldenring", 9531);
    expect(mod).toMatchObject({ modId: 9531, domainName: "eldenring", available: true });

    const { files } = await client.getModFiles("eldenring", 9531);
    expect(files.some((file) => file.fileId === 47215 && file.categoryName === "MAIN")).toBe(true);

    const { requirements } = await client.getModRequirements("eldenring", 9531);
    expect(requirements.dlcRequirements.some((item) => item.name === "Shadow of the Erdtree")).toBe(true);
  });

  it("searches the full GraphQL index by downloads", async () => {
    const client = new NexusClient();
    const result = await client.searchMods({ domainName: "eldenring", query: "tool", sort: "downloads", count: 5 });
    expect(result.totalCount).toBeGreaterThan(0);
    expect(result.mods).toHaveLength(5);
    expect(result.mods.every((mod) => mod.domainName === "eldenring")).toBe(true);
  });

  it("classifies the non-Premium download authorization boundary", async () => {
    const client = new NexusClient();
    await expect(
      client.getDownloadLinks({ domainName: "eldenring", modId: 9531, fileId: 47215 })
    ).rejects.toMatchObject({ code: "DOWNLOAD_AUTH_REQUIRED", status: 403 });
  });
});
