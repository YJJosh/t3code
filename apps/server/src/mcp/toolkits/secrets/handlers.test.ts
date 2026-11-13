import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as AgentSecrets from "../../../secrets/AgentSecrets.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { SecretsToolkit } from "./tools.ts";

it.effect(
  "refuses shell execution outside full-access/default mode and returns actionable vault errors",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:secrets");
      for (const mode of ["approval-required", "plan", "full-access"] as const) {
        let commands = 0;
        const dependencies = Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment:secrets"),
            requestNamespace: "provider:secrets",
            thread: {
              threadId,
              providerSessionId: "provider:secrets",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities: new Set(["orchestration" as const]),
            issuedAt: 0,
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed(
                liveThreadShell(threadId, {
                  runtimeMode: mode === "plan" ? "full-access" : mode,
                  interactionMode: mode === "plan" ? "plan" : "default",
                }),
              ),
          }),
          Layer.mock(Project.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(AgentSecrets.AgentSecrets)({
            run: () =>
              Effect.sync(() => {
                commands++;
                throw new Error("Denied callers must not execute host commands");
              }),
            list: () =>
              Effect.fail(new AgentSecrets.AgentSecretError({ reason: "unshared_vault" })),
          }),
        );
        const toolkit = yield* SecretsToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
          ),
        );
        if (mode !== "full-access") {
          const denied = yield* toolkit
            .handle("secret_run", { command: "exit 0" })
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
          expect(denied.at(-1)?.result).toMatchObject({ code: "capability_denied" });
          expect(commands).toBe(0);
        } else {
          const refused = yield* toolkit
            .handle("secret_list", { vault: "private" })
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
          expect(refused.at(-1)?.result).toMatchObject({
            code: "invalid_request",
            message: expect.stringContaining("Settings → Secrets → Agent vaults"),
          });
        }
      }
    }),
);
