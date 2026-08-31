import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentsRoster } from "./agents/AgentsRoster";
import { AgentDetail } from "./agents/AgentDetail";
import { preferredInspectorAgent, workflowMembers } from "./agents/agentsPresentation";

const SPLIT_LAYOUT_MIN_WIDTH = 640;

function allPanelAgents(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  return [
    ...model.workflows.flatMap((group) => [group.workflow, ...workflowMembers(group)]),
    ...model.directAgents,
  ];
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
  const agents = useMemo(() => allPanelAgents(model), [model]);
  const visibleAgentCount = useMemo(
    () =>
      model.directAgents.length +
      model.workflows.reduce(
        (count, group) => count + Math.max(workflowMembers(group).length, 1),
        0,
      ),
    [model],
  );
  const preferredAgentId = useMemo(() => preferredInspectorAgent(agents)?.id ?? null, [agents]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [returnFocusAgentId, setReturnFocusAgentId] = useState<string | null>(null);
  const selectedAgent =
    selectedAgentId === null
      ? null
      : (agents.find((agent) => agent.id === selectedAgentId) ?? null);

  useEffect(() => {
    setSelectedAgentId(null);
    setReturnFocusAgentId(null);
  }, [environmentId, threadId]);

  useEffect(() => {
    if (selectedAgentId !== null && selectedAgent === null) setSelectedAgentId(null);
  }, [selectedAgent, selectedAgentId]);

  useEffect(() => {
    if (splitLayout && selectedAgentId === null && preferredAgentId !== null) {
      setSelectedAgentId(preferredAgentId);
    }
  }, [preferredAgentId, selectedAgentId, splitLayout]);

  const selectAgent = useCallback((agent: RuntimeSubagent) => {
    setReturnFocusAgentId(null);
    setSelectedAgentId(agent.id);
  }, []);
  const showRoster = useCallback(() => {
    setReturnFocusAgentId(selectedAgentId);
    setSelectedAgentId(null);
  }, [selectedAgentId]);

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-64 text-xs text-muted-foreground">
          When this thread spawns an agent or runs a workflow, its live status, activity, and usage
          will appear here.
        </p>
      </div>
    );
  }

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
          <aside className="flex w-72 min-w-64 shrink-0 flex-col border-r border-border/65">
            <AgentsRoster
              model={model}
              environmentId={environmentId}
              threadId={threadId}
              selectedAgentId={selectedAgentId}
              autoFocusAgentId={null}
              onSelectAgent={selectAgent}
            />
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            {selectedAgent ? (
              <AgentDetail
                agent={selectedAgent}
                environmentId={environmentId}
                threadId={threadId}
                controlsEnabled={taskControlsEnabled}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <Bot aria-hidden className="size-8 opacity-50" />
                <p className="text-sm font-medium text-foreground">Select an agent</p>
                <p className="max-w-64 text-xs">
                  Inspect activity, usage, results, and available controls without leaving the
                  roster.
                </p>
              </div>
            )}
          </main>
        </div>
      ) : selectedAgent ? (
        <AgentDetail
          agent={selectedAgent}
          environmentId={environmentId}
          threadId={threadId}
          controlsEnabled={taskControlsEnabled}
          onBack={showRoster}
        />
      ) : (
        <AgentsRoster
          model={model}
          environmentId={environmentId}
          threadId={threadId}
          selectedAgentId={null}
          autoFocusAgentId={returnFocusAgentId}
          onSelectAgent={selectAgent}
        />
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
