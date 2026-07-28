import { randomUUID } from "node:crypto";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { PackageUnit } from "../contracts.js";
import {
  computeInstallationMethodHash,
  installationMethodSchema,
  type DynamicGameContext,
  type EvidencePack,
  type InstallationMethod,
  type InstallPlanV2,
  type InstallProposal,
  type InstallProposalDraft,
  type MethodCheck,
} from "./contracts.js";

const TOKENS = {
  packageRoot: "${packageRoot}",
  packageName: "${packageName}",
  entryFile: "${entryFile}",
  entryDirectory: "${entryDirectory}",
  gameRoot: "${gameRoot}",
  liveModRoot: "${liveModRoot}",
} as const;

function selectedPackage(
  evidence: EvidencePack,
  packageUnitId: string,
): PackageUnit {
  const unit = evidence.packageUnits.find(
    (candidate) => candidate.packageUnitId === packageUnitId,
  );
  if (!unit) {
    throw new NexusError(
      "METHOD_STALE",
      "The selected package unit is absent from current Evidence.",
    );
  }
  return unit;
}

function packageName(unit: PackageUnit): string {
  return unit.packageRoot === "."
    ? (unit.identity.name ?? unit.identity.uniqueId ?? "package").replace(
        /[<>:"/\\|?*\u0000-\u001f]/g,
        "_",
      )
    : path.posix.basename(unit.packageRoot);
}

function replaceLiteral(
  value: string,
  literal: string,
  token: string,
): string {
  return value === literal ? token : value.split(literal).join(token);
}

function methodTargetTemplate(
  target: string,
  unit: PackageUnit,
): string {
  const name = packageName(unit);
  if (target === name) return TOKENS.packageName;
  if (target.endsWith(`/${name}`)) {
    return `${target.slice(0, -(name.length))}${TOKENS.packageName}`;
  }
  return target;
}

function remapCheck(
  check: MethodCheck,
  replacements: Readonly<Record<string, string>>,
  evidenceIds: ReadonlyArray<string>,
): MethodCheck {
  return {
    ...check,
    subject: expandTemplate(check.subject, replacements),
    expected:
      check.expected === null
        ? null
        : expandTemplate(check.expected, replacements),
    evidenceIds: [...evidenceIds],
  };
}

function expandTemplate(
  value: string,
  replacements: Readonly<Record<string, string>>,
): string {
  return Object.entries(replacements).reduce(
    (expanded, [token, replacement]) =>
      expanded.split(token).join(replacement),
    value,
  );
}

function entryForMethod(
  method: InstallationMethod,
  unit: PackageUnit,
): string {
  const entrySignal = method.scope.packageSignals.find(
    (signal) =>
      signal.kind === "file_name" &&
      signal.required &&
      signal.expected !== null,
  );
  const candidates =
    entrySignal?.expected === null || entrySignal?.expected === undefined
      ? unit.entryFiles
      : unit.entryFiles.filter((entry) =>
          entry.toLowerCase().includes(entrySignal.expected!.toLowerCase()),
        );
  if (candidates.length !== 1) {
    throw new NexusError(
      "METHOD_AMBIGUOUS",
      "The learned Method does not select exactly one current package entry.",
      { details: { candidates } },
    );
  }
  return candidates[0] as string;
}

export function deriveLearnedMethod(input: {
  proposal: InstallProposal;
  plan: InstallPlanV2;
  evidence: EvidencePack;
  context: DynamicGameContext;
  installationId: string;
}): InstallationMethod {
  if (input.proposal.strategyBinding.origin !== "agent_proposal") {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "Only a successful Agent Proposal can derive a new learned Method.",
    );
  }
  const unit = selectedPackage(
    input.evidence,
    input.proposal.selection.packageUnitId,
  );
  const operation = input.plan.operations[0];
  if (!operation) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "M4 learning requires at least one bounded operation.",
    );
  }
  const now = new Date().toISOString();
  const evidenceRefs = input.evidence.evidence.map(
    (reference) => reference.evidenceId,
  );
  const loader = input.context.detectedLoaders.find(
    (candidate) => candidate.state === "detected",
  );
  const commonScope = {
    operatingSystems: [input.context.instance.operatingSystem],
    gameSelectors: [
      {
        signalId: "game-identity",
        kind: "game_identity" as const,
        subject: "gameId",
        operator: "equals" as const,
        expected: input.context.game.gameId,
        required: true,
      },
    ],
    sourceSelectors: [],
    negativeSignals: [],
  };

  let withoutHash: Omit<InstallationMethod, "methodHash">;
  if (
    operation.kind === "run_bundled_installer" &&
    input.plan.operations.length === 1
  ) {
    const entryBasename = path.posix.basename(operation.entry.relativePath);
    const argumentTemplates = operation.arguments.map((argument) =>
      replaceLiteral(
        argument,
        input.context.instance.gameRoot,
        TOKENS.gameRoot,
      ),
    );
    withoutHash = {
      schemaVersion: 2,
      methodId: randomUUID(),
      revision: 1,
      state: "draft",
      createdAt: now,
      updatedAt: now,
      name: `${unit.identity.name ?? unit.identity.uniqueId ?? "Package"} controlled installer`,
      scope: {
        ...commonScope,
        loaderSelectors: [],
        packageSignals: [
          {
            signalId: "package-executable-installer",
            kind: "package_type",
            subject: "packageType",
            operator: "equals",
            expected: "executable-installer",
            required: true,
          },
          {
            signalId: "installer-entry-name",
            kind: "file_name",
            subject: "entryFile",
            operator: "contains",
            expected: entryBasename,
            required: true,
          },
        ],
      },
      resolution: {
        packageRootRules: [
          "Select the executable-installer package unit and its single matching hashed entry.",
        ],
        componentSelectionRules: [],
        targetMappings: [],
      },
      operationTemplates: [
        {
          templateId: "run-controlled-installer",
          kind: "run_bundled_installer",
          entryTemplate: TOKENS.entryFile,
          runtime: operation.entry.runtime,
          terminalMode: operation.terminalMode ?? "redirected_stdio",
          argumentTemplates,
          workingDirectoryTemplate: TOKENS.entryDirectory,
          declaredWriteRootTemplates: operation.declaredWriteRoots.map(
            (root) => root.path,
          ),
          timeoutMs: operation.timeoutMs,
        },
      ],
      preconditions: input.proposal.preconditions,
      verificationTemplate: {
        staticChecks: operation.postConditions,
        runtimeChecks: input.proposal.verificationRequirements.filter(
          (check) => check.kind === "log_contains",
        ),
        dependentMinimumLevel: "static_verified",
      },
      reversibilityRequirements: [
        {
          operationKind: "run_bundled_installer",
          level: operation.reversibilityLevel,
          requirement:
            "Snapshot every declared root and reject undeclared game-root changes.",
        },
      ],
      provenance: {
        origin: "agent_learned",
        evidenceRefs,
        derivedFromInstallationIds: [input.installationId],
        legacyAdapterBinding: null,
      },
      confidence: {
        deterministicSignals: [
          "game-identity",
          "package-executable-installer",
          "installer-entry-name",
        ],
        successfulApplications: 1,
        failedApplications: 0,
        lastVerifiedAt: now,
      },
    };
  } else if (
    operation.kind === "install_tree" &&
    input.plan.operations.length === 1
  ) {
    const targetTemplate = methodTargetTemplate(
      operation.targetRelativePath,
      unit,
    );
    const manifestSubject = `${targetTemplate}/manifest.json`;
    const portableEntryName =
      unit.identity.uniqueId?.startsWith("portable-tool:") &&
      unit.entryFiles.length === 1
        ? path.posix.basename(unit.entryFiles[0]!)
        : null;
    withoutHash = {
      schemaVersion: 2,
      methodId: randomUUID(),
      revision: 1,
      state: "draft",
      createdAt: now,
      updatedAt: now,
      name: `${unit.packageType} self-contained folder`,
      scope: {
        ...commonScope,
        loaderSelectors:
          loader === undefined
            ? []
            : [
                {
                  signalId: `loader-${loader.loaderId}`,
                  kind: "loader_state",
                  subject: loader.loaderId,
                  operator: "equals",
                  expected: `${loader.loaderId}:detected`,
                  required: true,
                },
              ],
        packageSignals: [
          {
            signalId: `package-${unit.packageType}`,
            kind: "package_type",
            subject: "packageType",
            operator: "equals",
            expected: unit.packageType,
            required: true,
          },
          ...(portableEntryName === null
            ? []
            : [
                {
                  signalId: "portable-entry-name",
                  kind: "file_name" as const,
                  subject: "entryFile",
                  operator: "contains" as const,
                  expected: portableEntryName,
                  required: true,
                },
              ]),
        ],
      },
      resolution: {
        packageRootRules: ["Use the exact analyzed package root."],
        componentSelectionRules: [],
        targetMappings: [
          {
            mappingId: "selected-live-mod-root",
            sourceTemplate: TOKENS.packageRoot,
            targetTemplate,
          },
        ],
      },
      operationTemplates: [
        {
          templateId: "install-selected-package-tree",
          kind: "install_tree",
          sourceTemplate: TOKENS.packageRoot,
          targetTemplate,
          ownershipMode: operation.ownershipMode,
        },
      ],
      preconditions: input.proposal.preconditions,
      verificationTemplate: {
        staticChecks:
          input.proposal.verificationRequirements.length > 0
            ? input.proposal.verificationRequirements
            : [
                {
                  checkId: "installed-manifest-present",
                  kind: "path_exists",
                  subject: manifestSubject,
                  expected: null,
                  required: true,
                  evidenceIds: evidenceRefs,
                },
              ],
        runtimeChecks: [],
        dependentMinimumLevel: "static_verified",
      },
      reversibilityRequirements: [
        {
          operationKind: "install_tree",
          level: "full",
          requirement:
            "Record the installed tree and preserve any captured pre-state.",
        },
      ],
      provenance: {
        origin: "agent_learned",
        evidenceRefs,
        derivedFromInstallationIds: [input.installationId],
        legacyAdapterBinding: null,
      },
      confidence: {
        deterministicSignals: [
          "game-identity",
          `package-${unit.packageType}`,
          ...(portableEntryName === null ? [] : ["portable-entry-name"]),
          ...(loader === undefined ? [] : [`loader-${loader.loaderId}`]),
        ],
        successfulApplications: 1,
        failedApplications: 0,
        lastVerifiedAt: now,
      },
    };
  } else if (
    input.plan.operations.every((candidate) =>
      [
        "ensure_directory",
        "install_new_file",
        "replace_file",
      ].includes(candidate.kind),
    )
  ) {
    const nexusIdentity = input.evidence.source.nexus
      ? `${input.evidence.source.nexus.domainName}:${input.evidence.source.nexus.modId}`
      : null;
    const fileOperations = input.plan.operations.filter(
      (
        candidate,
      ): candidate is Extract<
        (typeof input.plan.operations)[number],
        {
          kind:
            | "ensure_directory"
            | "install_new_file"
            | "replace_file";
        }
      > =>
        candidate.kind === "ensure_directory" ||
        candidate.kind === "install_new_file" ||
        candidate.kind === "replace_file",
    );
    const operationTemplates = fileOperations.map((candidate, index) => ({
      templateId: `mapped-file-${index + 1}`,
      kind: candidate.kind,
      sourceTemplate:
        candidate.kind === "ensure_directory"
          ? null
          : candidate.sourceRelativePath,
      targetTemplate: candidate.targetRelativePath,
      ownershipMode:
        candidate.kind === "ensure_directory"
          ? null
          : candidate.kind === "install_new_file"
            ? ("installed_file_set" as const)
            : ("layered_path" as const),
    }));
    const targetMappings = fileOperations
      .filter(
        (
          candidate,
        ): candidate is Extract<
          (typeof fileOperations)[number],
          { kind: "install_new_file" | "replace_file" }
        > => candidate.kind !== "ensure_directory",
      )
      .map((candidate, index) => ({
        mappingId: `mapped-source-${index + 1}`,
        sourceTemplate: candidate.sourceRelativePath,
        targetTemplate: candidate.targetRelativePath,
      }));
    const operationKinds = [
      ...new Set(fileOperations.map((candidate) => candidate.kind)),
    ];
    withoutHash = {
      schemaVersion: 2,
      methodId: randomUUID(),
      revision: 1,
      state: "draft",
      createdAt: now,
      updatedAt: now,
      name: `${unit.identity.name ?? "root-overlay"} bounded file mapping`,
      scope: {
        ...commonScope,
        loaderSelectors: [],
        sourceSelectors:
          nexusIdentity === null
            ? []
            : [
                {
                  signalId: "nexus-source-identity",
                  kind: "source_identity",
                  subject: "nexusMod",
                  operator: "equals",
                  expected: nexusIdentity,
                  required: true,
                },
              ],
        packageSignals: [
          {
            signalId: `package-${unit.packageType}`,
            kind: "package_type",
            subject: "packageType",
            operator: "equals",
            expected: unit.packageType,
            required: true,
          },
          ...fileOperations
            .filter(
              (
                candidate,
              ): candidate is Extract<
                (typeof fileOperations)[number],
                { kind: "install_new_file" | "replace_file" }
              > => candidate.kind !== "ensure_directory",
            )
            .map((candidate, index) => ({
              signalId: `mapped-source-${index + 1}`,
              kind: "path_exists" as const,
              subject: "archiveEntry",
              operator: "equals" as const,
              expected: candidate.sourceRelativePath,
              required: true,
            })),
        ],
      },
      resolution: {
        packageRootRules: ["Use the exact analyzed root-overlay package root."],
        componentSelectionRules: [],
        targetMappings,
      },
      operationTemplates,
      preconditions: input.proposal.preconditions,
      verificationTemplate: {
        staticChecks:
          input.proposal.verificationRequirements.length > 0
            ? input.proposal.verificationRequirements
            : fileOperations
                .filter((candidate) => candidate.kind !== "ensure_directory")
                .map((candidate, index) => ({
                  checkId: `mapped-target-${index + 1}`,
                  kind: "path_exists" as const,
                  subject: candidate.targetRelativePath,
                  expected: null,
                  required: true,
                  evidenceIds: evidenceRefs,
                })),
        runtimeChecks: [],
        dependentMinimumLevel: "static_verified",
      },
      reversibilityRequirements: operationKinds.map((kind) => ({
        operationKind: kind,
        level: "full" as const,
        requirement:
          kind === "replace_file"
            ? "Preserve and verify the replaced file preimage backup."
            : "Record each created path and remove only unchanged owned content.",
      })),
      provenance: {
        origin: "agent_learned",
        evidenceRefs,
        derivedFromInstallationIds: [input.installationId],
        legacyAdapterBinding: null,
      },
      confidence: {
        deterministicSignals: [
          "game-identity",
          `package-${unit.packageType}`,
          ...(nexusIdentity === null ? [] : ["nexus-source-identity"]),
          ...fileOperations
            .filter((candidate) => candidate.kind !== "ensure_directory")
            .map((_, index) => `mapped-source-${index + 1}`),
        ],
        successfulApplications: 1,
        failedApplications: 0,
        lastVerifiedAt: now,
      },
    };
  } else {
    throw new NexusError(
      "OPERATION_CAPABILITY_MISSING",
      `M4 cannot learn operation ${operation.kind}.`,
    );
  }
  return installationMethodSchema.parse({
    ...withoutHash,
    methodHash: computeInstallationMethodHash(withoutHash),
  });
}

export function instantiateLearnedMethod(input: {
  method: InstallationMethod;
  evidence: EvidencePack;
  context: DynamicGameContext;
  packageUnitId: string;
}): InstallProposalDraft {
  if (!["local_verified", "promoted"].includes(input.method.state)) {
    throw new NexusError(
      "METHOD_STALE",
      "Only a local_verified or promoted Method can be instantiated.",
    );
  }
  const unit = selectedPackage(input.evidence, input.packageUnitId);
  const needsEntry = input.method.operationTemplates.some(
    (template) => template.kind === "run_bundled_installer",
  );
  const entryFile = needsEntry
    ? entryForMethod(input.method, unit)
    : (unit.entryFiles[0] ?? unit.packageRoot);
  const currentEvidenceIds = input.evidence.evidence.map(
    (reference) => reference.evidenceId,
  );
  const liveModRoot =
    input.context.pathPolicy.liveModRoots.find(
      (root) => root.scope === "game_root",
    )?.path ?? "Mods";
  const replacements: Record<string, string> = {
    [TOKENS.packageRoot]: unit.packageRoot,
    [TOKENS.packageName]: packageName(unit),
    [TOKENS.entryFile]: entryFile,
    [TOKENS.entryDirectory]: path.posix.dirname(entryFile),
    [TOKENS.gameRoot]: input.context.instance.gameRoot,
    [TOKENS.liveModRoot]: liveModRoot,
  };
  const operations: InstallProposalDraft["operations"] =
    input.method.operationTemplates.map((template) => {
      if (template.kind === "run_bundled_installer") {
        const selectedEntry = expandTemplate(
          template.entryTemplate,
          replacements,
        );
        const entryEvidence = input.evidence.archive.entries.find(
          (entry) => entry.relativePath === selectedEntry,
        );
        if (entryEvidence?.sha256 === null || entryEvidence?.sha256 === undefined) {
          throw new NexusError(
            "EVIDENCE_CONFLICT",
            "Current Evidence has no hash for the learned installer entry.",
          );
        }
        return {
          operationId: randomUUID(),
          kind: "run_bundled_installer",
          entry: {
            source: "verified_staging",
            relativePath: selectedEntry,
            runtime: template.runtime,
            sha256: entryEvidence.sha256,
          },
          terminalMode: template.terminalMode ?? "redirected_stdio",
          arguments: template.argumentTemplates.map((argument) =>
            expandTemplate(argument, replacements),
          ),
          workingDirectory: expandTemplate(
            template.workingDirectoryTemplate,
            replacements,
          ),
          environmentPolicy: "minimal",
          timeoutMs: template.timeoutMs,
          allowedExitCodes: [0],
          declaredWriteRoots: template.declaredWriteRootTemplates.map(
            (root) => ({
              scope: "game_root" as const,
              path: expandTemplate(root, replacements),
              evidenceIds: [...currentEvidenceIds],
            }),
          ),
          postConditions: input.method.verificationTemplate.staticChecks.map(
            (check) => remapCheck(check, replacements, currentEvidenceIds),
          ),
          reversibilityLevel:
            input.method.reversibilityRequirements.find(
              (requirement) =>
                requirement.operationKind === "run_bundled_installer",
            )?.level ?? "manual_recovery",
        };
      }
      if (template.kind === "ensure_directory") {
        return {
          operationId: randomUUID(),
          kind: "ensure_directory",
          sourceRelativePath: null,
          targetRelativePath: expandTemplate(
            template.targetTemplate,
            replacements,
          ),
          ownershipMode: null,
        };
      }
      if (
        template.kind === "install_new_file" ||
        template.kind === "replace_file"
      ) {
        if (template.sourceTemplate === null) {
          throw new NexusError(
            "METHOD_STALE",
            `Learned ${template.kind} has no source template.`,
          );
        }
        return {
          operationId: randomUUID(),
          kind: template.kind,
          sourceRelativePath: expandTemplate(
            template.sourceTemplate,
            replacements,
          ),
          targetRelativePath: expandTemplate(
            template.targetTemplate,
            replacements,
          ),
          ownershipMode:
            template.kind === "install_new_file"
              ? ("installed_file_set" as const)
              : ("layered_path" as const),
        };
      }
      if (template.kind !== "install_tree") {
        throw new NexusError(
          "OPERATION_CAPABILITY_MISSING",
          `M4 cannot instantiate learned operation ${template.kind}.`,
        );
      }
      return {
        operationId: randomUUID(),
        kind: "install_tree",
        sourceRelativePath:
          template.sourceTemplate === null
            ? unit.packageRoot
            : expandTemplate(template.sourceTemplate, replacements),
        targetRelativePath: expandTemplate(
          template.targetTemplate,
          replacements,
        ),
        ownershipMode: template.ownershipMode,
      };
    });
  const installer = operations.some(
    (operation) => operation.kind === "run_bundled_installer",
  );
  const replacesFiles = operations.some(
    (operation) => operation.kind === "replace_file",
  );
  return {
    strategyBinding: {
      origin: "learned_method",
      methodId: input.method.methodId,
      methodRevision: input.method.revision,
      methodHash: input.method.methodHash,
      legacyAdapterBinding: null,
    },
    selection: {
      packageUnitId: unit.packageUnitId,
      packageRoot: unit.packageRoot,
      selectedComponents: [],
    },
    operations,
    preconditions: input.method.preconditions.map((check) =>
      remapCheck(check, replacements, currentEvidenceIds),
    ),
    verificationRequirements:
      input.method.verificationTemplate.runtimeChecks.map((check) =>
        remapCheck(check, replacements, currentEvidenceIds),
      ),
    unresolvedChoices: [],
    risk: {
      level: installer || replacesFiles ? "high" : "low",
      reasons: installer
        ? ["A learned Method will execute one evidence-hashed bundled installer."]
        : replacesFiles
          ? [
              "A verified Method will replace one or more bounded files with backup-backed operations.",
            ]
          : [
              "A verified Method installs one self-contained package tree or bounded file mapping.",
            ],
    },
  };
}
