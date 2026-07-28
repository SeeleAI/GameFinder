import { describe, expect, it } from "vitest";

import { evaluateVersionConstraint } from "../src/install/version-constraint.js";

describe("local installation version constraints", () => {
  it("supports explicit Nexus-style minimum and comparison constraints", () => {
    expect(evaluateVersionConstraint("4.5.2", "v4.1.7+")).toMatchObject({
      operator: ">=",
      normalizedInstalledVersion: "4.5.2",
      normalizedRequiredVersion: "4.1.7",
      status: "satisfied",
    });
    expect(evaluateVersionConstraint("4.0.6", ">=4.1.7")).toMatchObject({
      status: "not_satisfied",
    });
    expect(evaluateVersionConstraint("2.3.7", "=2.3.7.0")).toMatchObject({
      status: "satisfied",
    });
  });

  it("keeps natural-language and unknown-version requirements unresolved", () => {
    expect(
      evaluateVersionConstraint("4.5.2", "requires the latest stable SMAPI"),
    ).toMatchObject({
      status: "unknown",
      operator: null,
    });
    expect(evaluateVersionConstraint(null, "v4.1.7+")).toMatchObject({
      status: "unknown",
      normalizedRequiredVersion: "4.1.7",
    });
  });
});
