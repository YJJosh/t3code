import type {
  DulliPanelModel,
  DulliInspectorWorkflowGroup,
  DulliInspectorAgent,
} from "@t3tools/client-runtime/state/dulliSubagents";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/dulliSubagents";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import { deriveDulliAgentInspector } from "@t3tools/client-runtime/state/dulliSubagents";
import { Bot } from "lucide-react";
import { observeResize } from "~/lib/observeResize";
import { useEffect, useState } from "react";

import { AgentDetail } from "./agents/AgentDetail";
import { AgentsRoster } from "./agents/AgentsRoster";
import { preferredInspectorAgent, workflowMembers } from "./agents/agentsPresentation";
import { WorkflowDetail } from "./agents/WorkflowDetail";

const SPLIT_LAYOUT_MIN_WIDTH = 640;

type InspectorSelection =
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string };

function panelAgents(model: DulliPanelModel): ReadonlyArray<DulliInspectorAgent> {
  return [...model.workflows.flatMap(workflowMembers), ...model.directAgents];
}

/** Side-by-side roster/detail once this panel is at least 640px wide. */
// The empty state and the inspector render different roots. A ref object
// only observed whichever existed at mount, so opening the panel before the first
// agent left the layout stuck. Observing the current element follows the swap.
function useSplitInspectorLayout(root: HTMLDivElement | null): boolean {
  const [split, setSplit] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the current panel DOM root’s width, including swaps between empty and inspector roots.
  useEffect(() => {
    if (!root) return;
    return observeResize(root, ([entry]) => {
      if (entry) setSplit(entry.contentRect.width >= SPLIT_LAYOUT_MIN_WIDTH);
    });
  }, [root]);

  return split;
}

export function AgentsPanel({
  environmentId,
  projection,
}: {
  environmentId: EnvironmentId;
  projection: ThreadStructure;
}) {
  const inspector = deriveDulliAgentInspector(projection);
  return (
    <Inspector
      key={`${environmentId}:${projection.thread.id}`}
      inspector={inspector}
      environmentId={environmentId}
      threadId={projection.thread.id}
    />
  );
}

function Inspector({
  inspector,
  environmentId,
  threadId,
}: {
  inspector: ReturnType<typeof deriveDulliAgentInspector>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const model = inspector.presentation;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const splitLayout = useSplitInspectorLayout(root);
  const agents = panelAgents(model);
  const workflows = model.workflows;
  const visibleAgentCount =
    model.directAgents.length +
    model.workflows.reduce((count, group) => count + workflowMembers(group).length, 0);
  const preferredSelection = ((): InspectorSelection | null => {
    const preferredAgent = preferredInspectorAgent(agents);
    if (preferredAgent) {
      const workflow = workflows.find((group) =>
        workflowMembers(group).some((member) => member.id === preferredAgent.id),
      );
      return workflow
        ? { kind: "workflow", id: workflow.workflow.id }
        : { kind: "agent", id: preferredAgent.id };
    }
    const workflow = workflows.at(-1);
    return workflow ? { kind: "workflow", id: workflow.workflow.id } : null;
  })();
  const [requestedSelection, setSelection] = useState<InspectorSelection | null>(null);
  // Persist the initial split-pane choice. Following the changing preference
  // on every update remounts detail and discards a draft when another agent waits.
  // Adjusted during render, so the first paint already shows the stored choice.
  if (
    splitLayout &&
    preferredSelection &&
    requestedSelection?.id !== preferredSelection.id &&
    (!requestedSelection || !model.agents.some((agent) => agent.id === requestedSelection.id))
  ) {
    setSelection(preferredSelection);
  }
  const selection =
    requestedSelection && model.agents.some((agent) => agent.id === requestedSelection.id)
      ? requestedSelection
      : splitLayout
        ? preferredSelection
        : null;
  const [returnFocusTargetId, setReturnFocusTargetId] = useState<string | null>(null);
  const selectedAgent =
    selection?.kind === "agent"
      ? (agents.find((agent) => agent.id === selection.id) ?? null)
      : null;
  const selectedWorkflow =
    selection?.kind === "workflow"
      ? (workflows.find((group) => group.workflow.id === selection.id) ?? null)
      : null;
  const parentWorkflow =
    workflows.find((group) => group.workflow.id === selectedAgent?.parentAgentId) ?? null;

  const selectRosterAgent = (agent: DulliInspectorAgent) => {
    setReturnFocusTargetId(null);
    setSelection({ kind: "agent", id: agent.id });
  };
  const selectWorkflow = (group: DulliInspectorWorkflowGroup) => {
    setReturnFocusTargetId(null);
    setSelection({ kind: "workflow", id: group.workflow.id });
  };
  const selectWorkflowAgent = (group: DulliInspectorWorkflowGroup, agent: DulliInspectorAgent) => {
    setReturnFocusTargetId(null);
    setSelection({ kind: "agent", id: agent.id });
  };
  const showRoster = () => {
    setReturnFocusTargetId(selection?.id ?? null);
    setSelection(null);
  };
  const showParentWorkflow = () => {
    if (!parentWorkflow) {
      showRoster();
      return;
    }
    setSelection({ kind: "workflow", id: parentWorkflow.workflow.id });
  };

  if (!model.hasAgents) {
    return (
      <div
        ref={setRoot}
        className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      >
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-64 text-xs text-muted-foreground">
          When this thread spawns an agent or runs a workflow, its live conversation and status will
          appear here.
        </p>
      </div>
    );
  }

  const roster = (
    <AgentsRoster
      model={model}
      selectedAgentId={selectedAgent?.id ?? null}
      selectedWorkflowId={selectedWorkflow?.workflow.id ?? parentWorkflow?.workflow.id ?? null}
      autoFocusTargetId={returnFocusTargetId}
      onSelectAgent={selectRosterAgent}
      onSelectWorkflow={selectWorkflow}
    />
  );
  const detail = selectedWorkflow ? (
    <WorkflowDetail
      key={selectedWorkflow.workflow.id}
      group={selectedWorkflow}
      selectedAgentId={null}
      onSelectAgent={(agent) => selectWorkflowAgent(selectedWorkflow, agent)}
      {...(!splitLayout ? { onBack: showRoster } : {})}
    />
  ) : selectedAgent ? (
    <AgentDetail
      key={selectedAgent.id}
      agent={selectedAgent}
      environmentId={environmentId}
      threadId={threadId}
      controlsEnabled={inspector.canControl(selectedAgent.source)}
      revision={inspector.revision(selectedAgent.id)}
      transcriptFor={inspector.transcript}
      {...(parentWorkflow
        ? { onBack: showParentWorkflow, backLabel: "Back to workflow" }
        : !splitLayout
          ? { onBack: showRoster }
          : {})}
    />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <Bot aria-hidden className="size-8 opacity-50" />
      <p className="text-sm font-medium text-foreground">Select an agent or workflow</p>
      <p className="max-w-72 text-xs">
        Workflows open as phase trees. Agents open as live conversations with reasoning and tools.
      </p>
    </div>
  );

  return (
    <div
      ref={setRoot}
      className="flex h-full min-h-0 flex-col"
      data-agent-inspector-layout={splitLayout ? "split" : "compact"}
    >
      <header className="shrink-0 border-b border-border/65 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <h1 className="text-sm font-semibold text-foreground">Agent inspector</h1>
          <span className="text-2xs text-muted-foreground">
            {visibleAgentCount} agent{visibleAgentCount === 1 ? "" : "s"}
            {workflows.length > 0
              ? ` · ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {model.runningCount + model.waitingCount > 0
            ? `${model.runningCount + model.waitingCount} working`
            : "No active agents"}
          {model.idleCount > 0 ? ` · ${model.idleCount} idle` : ""}
          {model.settledCount > 0 ? ` · ${model.settledCount} settled` : ""}
        </p>
      </header>

      {splitLayout ? (
        <div className="flex min-h-0 flex-1">
          <aside
            aria-label="Agent runs"
            className="flex w-72 min-w-64 shrink-0 flex-col border-r border-border/65"
          >
            {roster}
          </aside>
          <section aria-label="Agent detail" className="flex min-w-0 flex-1 flex-col">
            {detail}
          </section>
        </div>
      ) : selectedAgent || selectedWorkflow ? (
        detail
      ) : (
        roster
      )}

      <footer className="flex shrink-0 items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-2xs text-muted-foreground">
        <span>
          {model.runningCount + model.waitingCount > 0
            ? `● ${model.runningCount + model.waitingCount} working`
            : `${model.settledCount} settled`}
        </span>
        <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
      </footer>
    </div>
  );
}
