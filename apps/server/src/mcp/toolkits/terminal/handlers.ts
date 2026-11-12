import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as TerminalMcpService from "../../TerminalMcpService.ts";
import { TerminalToolkit } from "./tools.ts";

const threadScope = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

const handlers = {
  terminal_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* TerminalMcpService.TerminalMcpService;
      return yield* service.start(yield* threadScope, input);
    }),
  ),
  terminal_send: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* TerminalMcpService.TerminalMcpService;
      return yield* service.send(yield* threadScope, input);
    }),
  ),
  terminal_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* TerminalMcpService.TerminalMcpService;
      return yield* service.read(yield* threadScope, input);
    }),
  ),
  terminal_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const service = yield* TerminalMcpService.TerminalMcpService;
      return yield* service.list(yield* threadScope);
    }),
  ),
  terminal_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* TerminalMcpService.TerminalMcpService;
      return yield* service.close(yield* threadScope, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof TerminalToolkit.tools>;

export const layer = McpToolAccess.toLayer(TerminalToolkit, handlers);
