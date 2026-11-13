import type { TerminalSummary } from "@t3tools/contracts";

export interface ThreadTerminalGroups {
  readonly running: ReadonlyArray<TerminalSummary>;
  readonly settled: ReadonlyArray<TerminalSummary>;
  readonly failedCount: number;
}

export function terminalFailed(summary: TerminalSummary): boolean {
  return summary.status === "error" || (summary.exitCode !== null && summary.exitCode !== 0);
}

/** An idle shell the user owns is just a prompt; only work worth watching makes a group. */
export function groupThreadTerminals(
  summaries: ReadonlyArray<TerminalSummary>,
): ThreadTerminalGroups {
  const running: TerminalSummary[] = [];
  const settled: TerminalSummary[] = [];
  for (const summary of summaries) {
    if (summary.status === "exited" || summary.status === "error") settled.push(summary);
    else if (summary.controller === "agent" || summary.hasRunningSubprocess) running.push(summary);
  }
  return { running, settled, failedCount: settled.filter(terminalFailed).length };
}

export function terminalGroupLabel(group: "running" | "settled", count: number): string {
  return `${count} ${group} terminal${count === 1 ? "" : "s"}`;
}

export function terminalStatusLabel(summary: TerminalSummary): string {
  if (summary.status === "error") return "Error";
  if (summary.status === "exited") {
    return summary.exitCode === null || summary.exitCode === 0
      ? "Exited"
      : `Exit ${summary.exitCode}`;
  }
  return summary.hasRunningSubprocess ? "Running" : "Idle";
}
