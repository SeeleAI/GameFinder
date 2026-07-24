import { NexusBrowserService } from "../src/browser/browser-service.js";
import { asNexusError } from "../src/errors.js";

async function main(): Promise<void> {
  const browser = new NexusBrowserService();
  try {
    const login = await browser.openLogin();
    if (login.state !== "authenticated") {
      throw new Error(
        `Persistent Nexus login was not retained; observed ${login.state}. Run pnpm acceptance:browser-login first.`
      );
    }
    console.log("Persistent Nexus login verified after a fresh browser service start.");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const nexusError = asNexusError(error);
  console.error(`${nexusError.code}: ${nexusError.message}`);
  process.exitCode = 1;
});
