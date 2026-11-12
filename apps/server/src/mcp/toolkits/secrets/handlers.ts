import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AgentSecrets from "../../../secrets/AgentSecrets.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, readCaller, unavailable } from "../../threadAccess.ts";
import { SecretsToolkit } from "./tools.ts";

const failure = (error: AgentSecrets.AgentSecretError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(SecretsToolkit, {
  secret_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const service = yield* AgentSecrets.AgentSecrets;
      return { items: yield* service.list(input.vault).pipe(Effect.mapError(failure)) };
    }),
  ),
  secret_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      yield* assertFullAccess(
        context,
        "secret_run executes a host shell command and needs full-access/default mode.",
      );
      const caller = context.caller;
      if (caller === undefined) return yield* unavailable();
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(caller.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project)) return yield* unavailable();
      const service = yield* AgentSecrets.AgentSecrets;
      return yield* service
        .run({ ...input, cwd: caller.worktreePath ?? project.value.workspaceRoot })
        .pipe(Effect.mapError(failure));
    }),
  ),
});
