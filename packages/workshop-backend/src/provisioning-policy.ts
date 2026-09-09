// Helpers for interpreting the OrganizationDirectory's live app-access decision.
//
// Availability is never read from AdminConfig. The directory is the only policy authority in
// central-auth deployments; legacy-auth callers pass an explicit optional decision for ordinary
// connectors and ambient opt-in.

import type { AppAccessResult } from "@gadgets/workshop-shared/api";

/** Whether an account may be selected through the user opt-in/connect flow. */
export function canOptIntoAccount(access: AppAccessResult): boolean {
  return access.allowed && access.mode === "optional";
}

/** Whether an ambient account may be created automatically for this subject. */
export function shouldAutoProvisionAccount(access: AppAccessResult): boolean {
  return access.allowed && access.mode === "enabled";
}
