import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentDetail } from "./agents/AgentDetail";
import { AgentsRoster } from "./agents/AgentsRoster";
import { preferredInspectorAgent, workflowMembers } from "./agents/agentsPresentation";
import { WorkflowDetail } from "./agents/WorkflowDetail";

const SPLIT_LAYOUT_MIN_WIDTH = 640;

type InspectorSelection =
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string };

function panelAgents(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  return [...model.workflows.flatMap(workflowMembers), ...model.directAgents];
}

function useSplitInspectorLayout(rootRef: React.RefObject<HTMLDivElement | null>): boolean {
  const [split, setSplit] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => {
      const next = width >= SPLIT_LAYOUT_MIN_WIDTH;
      setSplit((current) => (current === next ? current : next));
    };
    update(root.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootRef]);

  return split;
}

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  taskControlsEnabled = false,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  taskControlsEnabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const splitLayout = useSplitInspectorLayout(rootRef);
  const agents = useMemo(() => panelAgents(model), [model]);
  const workflows = model.workflows;
  const visibleAgentCount = useMemo(
    () =>
      model.directAgents.length +
      model.workflows.reduce((count, group) => count + workflowMembers(group).length, 0),
    [model],
  );
  const preferredSelection = useMemo<InspectorSelection | null>(() => {
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
  }, [agents, workflows]);
  const [selection, setSelection] = useState<InspectorSelection | null>(null);
  const [returnFocusTargetId, setReturnFocusTargetId] = useState<string | null>(null);
  const [agentWorkflowId, setAgentWorkflowId] = useState<string | null>(null);
  const selectedAgent =
    selection?.kind === "agent"
      ? (agents.find((agent) => agent.id === selection.id) ?? null)
      : null;
  const selectedWorkflow =
    selection?.kind === "workflow"
      ? (workflows.find((group) => group.workflow.id === selection.id) ?? null)
      : null;
  const parentWorkflow =
    agentWorkflowId === null
      ? null
      : (workflows.find((group) => group.workflow.id === agentWorkflowId) ?? null);

  useEffect(() => {
    setSelection(null);
    setReturnFocusTargetId(null);
    setAgentWorkflowId(null);
  }, [environmentId, threadId]);

  useEffect(() => {
    if (
      selection &&
      ((selection.kind === "agent" && selectedAgent === null) ||
        (selection.kind === "workflow" && selectedWorkflow === null))
    ) {
      setSelection(null);
      setAgentWorkflowId(null);
    }
  }, [selectedAgent, selectedWorkflow, selection]);

  useEffect(() => {
    if (splitLayout && selection === null && preferredSelection !== null) {
      setSelection(preferredSelection);
    }
  }, [preferredSelection, selection, splitLayout]);

  const selectRosterAgent = useCallback((agent: RuntimeSubagent) => {
    setReturnFocusTargetId(null);
    setAgentWorkflowId(null);
    setSelection({ kind: "agent", id: agent.id });
  }, []);
  const selectWorkflow = useCallback((group: AgentPanelWorkflowGroup) => {
    setReturnFocusTargetId(null);
    setAgentWorkflowId(null);
    setSelection({ kind: "workflow", id: group.workflow.id });
  }, []);
  const selectWorkflowAgent = useCallback(
    (group: AgentPanelWorkflowGroup, agent: RuntimeSubagent) => {
      setReturnFocusTargetId(null);
      setAgentWorkflowId(group.workflow.id);
      setSelection({ kind: "agent", id: agent.id });
    },
    [],
  );
  const showRoster = useCallback(() => {
    setReturnFocusTargetId(selection?.id ?? null);
    setAgentWorkflowId(null);
    setSelection(null);
  }, [selection]);
  const showParentWorkflow = useCallback(() => {
    if (!parentWorkflow) {
      showRoster();
      return;
    }
    setAgentWorkflowId(null);
    setSelection({ kind: "workflow", id: parentWorkflow.workflow.id });
  }, [parentWorkflow, showRoster]);

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
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
      group={selectedWorkflow}
      selectedAgentId={null}
      onSelectAgent={(agent) => selectWorkflowAgent(selectedWorkflow, agent)}
      {...(!splitLayout ? { onBack: showRoster } : {})}
    />
  ) : selectedAgent ? (
    <AgentDetail
      agent={selectedAgent}
      environmentId={environmentId}
      threadId={threadId}
      controlsEnabled={taskControlsEnabled}
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
      ref={rootRef}
      className="flex h-full min-h-0 flex-col"
      data-agent-inspector-layout={splitLayout ? "split" : "compact"}
    >
      <header className="shrink-0 border-b border-border/65 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <h1 className="text-sm font-semibold text-foreground">Agent inspector</h1>
          <span className="text-[.7rem] text-muted-foreground">
            {visibleAgentCount} agent{visibleAgentCount === 1 ? "" : "s"}
            {workflows.length > 0
              ? ` · ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
        <p className="mt-0.5 text-[.7rem] text-muted-foreground">
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
      ) : selection ? (
        detail
      ) : (
        roster
      )}

      <footer className="flex shrink-0 items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
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
