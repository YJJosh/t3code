import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useEnvironmentScope } from "../state/session";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { parseMultiRepoCloneInput } from "@t3tools/client-runtime/operations/projects";
import { listMultiRepoProjectsToSetUp } from "@t3tools/client-runtime/state/project-grouping";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { projectEnvironment } from "../state/projects";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { newProjectId } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export function MultiRepoProjectForm(props: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<EnvironmentProject>;
  onBack: () => void;
  onCreated: (project: ScopedProjectRef) => Promise<void>;
}) {
  const [folder, setFolder] = useState("");
  const [repositories, setRepositories] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const inspect = useAtomCommand(projectEnvironment.inspectMultiRepoFolder, {
    reportFailure: false,
  });
  const create = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const makeGroup = useAtomCommand(projectEnvironment.makeMultiRepo, { reportFailure: false });
  const clone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const canMakeGroup = useAtomValue(
    projectEnvironment.makeMultiRepo.permissionAtom(props.environmentId),
  );
  const canClone = useAtomValue(
    sourceControlEnvironment.startProjectClone.permissionAtom(props.environmentId),
  );
  const canCreate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canInspect = useAtomValue(
    projectEnvironment.inspectMultiRepoFolder.permissionAtom(props.environmentId),
  );
  const setups = listMultiRepoProjectsToSetUp(props.projects, props.environmentId);
  const [members, setMembers] = useState<ReadonlyArray<{ path: string; remoteUrl: string }> | null>(
    null,
  );

  const submit = () => {
    if (submitting.current || !folder.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const run = async () => {
      const inspected = await inspect({
        environmentId: props.environmentId,
        input: { path: folder },
      });
      if (inspected._tag === "Failure") throw squashAtomCommandFailure(inspected);
      const target = inspected.value;
      if (target.kind === "unavailable") throw new Error(target.reason ?? "Choose another folder.");
      let projectId =
        props.projects.find(
          (project) =>
            project.environmentId === props.environmentId && project.workspaceRoot === target.path,
        )?.id ?? newProjectId();
      if (target.kind === "empty" || target.kind === "missing") {
        const parsed = parseMultiRepoCloneInput(repositories);
        const selected = members ?? parsed.members;
        if (selected.length === 0 || (members === null && parsed.invalid.length > 0)) {
          throw new Error("Enter Git URLs or owner/repo names for the repositories to clone.");
        }
        const result = await clone({
          environmentId: props.environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(target.path),
            destinationPath: target.path,
            createdAt: new Date().toISOString(),
            members: selected,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        projectId = result.value.projectId;
      } else {
        if (
          !props.projects.some(
            (project) => project.environmentId === props.environmentId && project.id === projectId,
          )
        ) {
          const result = await create({
            environmentId: props.environmentId,
            input: {
              projectId,
              title: inferProjectTitleFromPath(target.path),
              workspaceRoot: target.path,
              defaultModelSelection: null,
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
        if (target.kind === "repositories") {
          const result = await makeGroup({
            environmentId: props.environmentId,
            input: { projectId },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
      }
      await props.onCreated(scopeProjectRef(props.environmentId, projectId));
    };
    void run()
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not add the multi-repo project.");
      })
      .finally(() => {
        submitting.current = false;
        setBusy(false);
      });
  };

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-lg font-medium">Multi-repo project</h2>
      <p className="text-sm text-muted-foreground">
        Choose a folder containing repositories, or an empty folder to clone into. Every new
        workspace uses one branch across all members.
      </p>
      <Input
        aria-label="Project folder"
        placeholder="Absolute project folder path"
        value={folder}
        onChange={(event) => setFolder(event.target.value)}
        disabled={busy}
      />
      <Textarea
        aria-label="Repositories to clone"
        placeholder="Git URLs or owner/repo names (only for an empty folder)"
        value={repositories}
        onChange={(event) => {
          setRepositories(event.target.value);
          setMembers(null);
        }}
        disabled={busy}
      />
      {setups.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {setups.map((setup) => (
            <Button
              key={setup.key}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setMembers(setup.members);
                setRepositories(setup.members.map((member) => member.remoteUrl).join("\n"));
              }}
            >
              Use {setup.source.title}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={props.onBack} disabled={busy}>
          Back
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={
            busy || !folder.trim() || !canMakeGroup || !canClone || !canCreate || !canInspect
          }
        >
          {busy ? "Adding…" : "Add project"}
        </Button>
      </div>
    </div>
  );
}
