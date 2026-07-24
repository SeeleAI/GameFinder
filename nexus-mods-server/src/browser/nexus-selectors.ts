import type { Locator, Page } from "playwright";

export type NexusLocatorScope = Page | Locator;

export const MANUAL_DOWNLOAD_NAME = /\bmanual\s+download\b/i;
export const REQUIREMENTS_CONTINUE_NAME = /^(?:continue(?:\s+download)?|download|download anyway)$/i;
export const STANDARD_DOWNLOAD_NAME = /\bstandard\s+download\b/i;
export const SLOW_DOWNLOAD_NAME = /\bslow\s+download\b/i;
export const RESUMABLE_DOWNLOAD_NAME = /\bresumable\s+download\b/i;

export const REQUIREMENTS_CONTAINER_SELECTORS = [
  '[role="dialog"][aria-modal="true"]',
  '[data-testid*="requirement" i]',
  '[data-test*="requirement" i]',
  '[class*="requirement" i]'
] as const;

export function namedAction(scope: NexusLocatorScope, name: RegExp): Locator {
  return scope.getByRole("button", { name }).or(scope.getByRole("link", { name }));
}

export function manualDownloadAction(scope: NexusLocatorScope): Locator {
  return namedAction(scope, MANUAL_DOWNLOAD_NAME);
}

export function requirementsContinueAction(scope: NexusLocatorScope): Locator {
  return namedAction(scope, REQUIREMENTS_CONTINUE_NAME);
}

export function standardDownloadAction(scope: NexusLocatorScope): Locator {
  return namedAction(scope, STANDARD_DOWNLOAD_NAME);
}

export function slowDownloadAction(scope: NexusLocatorScope): Locator {
  return namedAction(scope, SLOW_DOWNLOAD_NAME);
}

export function resumableDownloadAction(scope: NexusLocatorScope): Locator {
  return namedAction(scope, RESUMABLE_DOWNLOAD_NAME);
}

export function fileContainerSelectors(fileId: number): string[] {
  const id = String(fileId);
  return [`[data-fileid="${id}"]`, `[data-file-id="${id}"]`, `[data-id="${id}"]`];
}

export function fileReferenceSelector(fileId: number): string {
  const id = String(fileId);
  return `a[href*="file_id=${id}"], a[href*="/files/${id}"]`;
}
