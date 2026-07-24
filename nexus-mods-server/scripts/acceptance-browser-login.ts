import { setTimeout as delay } from "node:timers/promises";
import { NexusBrowserService } from "../src/browser/browser-service.js";
import { asNexusError } from "../src/errors.js";

async function main(): Promise<void> {
  const browser = new NexusBrowserService();
  try {
    const initial = await browser.openLogin();
    console.log(`Dedicated Nexus Chromium login state: ${initial.state}.`);
    if (initial.state === "authenticated") {
      console.log("Persistent Nexus login is already valid.");
      return;
    }

    console.log("Complete Nexus login, 2FA, or CAPTCHA in the visible Chromium window.");
    const expiresAt = initial.expiresAt ? Date.parse(initial.expiresAt) : Date.now() + 15 * 60_000;
    while (Date.now() < expiresAt) {
      await delay(2_000);
      const status = await browser.status();
      if (status.authState === "authenticated") {
        console.log("Persistent Nexus login verified.");
        return;
      }
      if (status.authState === "authentication_failed") {
        throw new Error("Nexus authentication could not be verified.");
      }
    }
    throw new Error("Timed out waiting for Nexus login.");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const nexusError = asNexusError(error);
  console.error(`${nexusError.code}: ${nexusError.message}`);
  process.exitCode = 1;
});
