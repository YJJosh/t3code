import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

export function threadAttentionKey(
  thread: Pick<OrchestrationV2ThreadShell, "latestRunId" | "pendingRuntimeRequest">,
  status: string,
): string | null {
  // each pending approval/input deserves an alert, even when the run and status do not change.
  return status === "input" || status === "approval" || status === "failed" || status === "limited"
    ? `${thread.latestRunId ?? ""}:${status}:${thread.pendingRuntimeRequest?.id ?? ""}`
    : null;
}
