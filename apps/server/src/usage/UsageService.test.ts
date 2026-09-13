// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

import { ServerSettings as ServerSettingsContract } from "@t3tools/contracts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  resolveConfiguredPiTranscriptDirs,
  resolvePiAgentDir,
  resolvePiSubagentTranscriptDirs,
  resolvePiTranscriptDir,
  resolveUsageSourceReadCoverage,
  resolveUsageTranscriptDirs,
} from "./UsageService.ts";

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providers: {
        claudeAgent: { homePath: NodePath.join(home, "claude") },
        codex: { homePath: NodePath.join(home, "codex") },
      },
    },
  };
});

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.onRatesFetch?.();
            // Unparsable rates: every scan retries the fetch, which makes the
            // fetch count a boundary-level observation of how many scans ran.
            return HttpClientResponse.fromWeb(request, Response.json(input.ratesDocument ?? {}));
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, {
        HOME: input.home,
        GROK_HOME: NodePath.join(input.home, "grok"),
      }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live("retains configured Pi roots and child discovery across warm and persisted scans", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const project = NodePath.join(home, "workspace", "project");
      const agentDir = NodePath.join(home, "pi");
      const workAgentDir = NodePath.join(home, "pi-work");
      const parentPath = NodePath.join(agentDir, "sessions", "project", "parent.jsonl");
      const workPath = NodePath.join(workAgentDir, "sessions", "project", "work.jsonl");
      const childPath = NodePath.join(
        project,
        ".pi-subagents",
        "runs",
        "run-1",
        "session",
        "child.jsonl",
      );
      const piHeader = (sessionId: string) =>
        [
          JSON.stringify({ type: "session", id: sessionId, cwd: project }),
          JSON.stringify({
            type: "model_change",
            provider: "anthropic",
            modelId: "claude-fable-5",
          }),
          "",
        ].join("\n");
      const piLine = (id: string, output: number) =>
        `${JSON.stringify({
          type: "message",
          id,
          timestamp: "2026-08-01T10:00:05Z",
          message: { role: "assistant", usage: { input: 30, output } },
        })}\n`;
      for (const path of [parentPath, workPath, childPath]) {
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(path), { recursive: true }));
      }
      yield* Effect.promise(() =>
        NodeFSP.writeFile(parentPath, piHeader("parent") + piLine("parent-entry", 5)),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(workPath, piHeader("work") + piLine("work-entry", 7)),
      );
      // A child/fork has copied history plus its own entry. Only its own work counts.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          childPath,
          piHeader("child") + piLine("parent-entry", 5) + piLine("child-entry", 11),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 23);
        assert.strictEqual(
          first.buckets.reduce((sum, bucket) => sum + bucket.records, 0),
          3,
        );
        const contributingRoots = first.buckets.map(
          (bucket) => first.sources[bucket.sourceIndex!]?.fingerprint.resolvedHomePath,
        );
        assert.sameMembers(contributingRoots, [
          NodePath.join(agentDir, "sessions"),
          NodePath.join(workAgentDir, "sessions"),
          NodePath.join(project, ".pi-subagents", "runs"),
        ]);

        const warm = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(warm.buckets, first.buckets);
        yield* Effect.promise(() =>
          NodeFSP.appendFile(childPath, piLine("child-appended", 13).trimEnd()),
        );
        const appended = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(appended), 36);

        // A fresh instance must find children using persisted parent metadata,
        // restore Pi reducer state, and consume a once-tail record only once.
        const restarted = yield* UsageService.make;
        yield* Effect.promise(() =>
          NodeFSP.appendFile(childPath, `\n${piLine("child-final", 17)}`),
        );
        const restored = yield* restarted.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(restored), 53);
        assert.strictEqual(
          restored.buckets.reduce((sum, bucket) => sum + bucket.records, 0),
          5,
        );
        assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, restored.buckets);
      }).pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-pi-resume-test",
            home,
            settings: decodeServerSettings({
              ...settings,
              providerInstances: {
                pi: { driver: "pi", config: { agentDir } },
                pi_work: { driver: "pi", config: { agentDir: workAgentDir } },
                pi_duplicate: { driver: "pi", config: { agentDir } },
              },
            }),
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("attributes usage to each configured Claude transcript home", () =>
    Effect.gen(function* () {
      const { settings, home, transcript } = yield* setup;
      const workHome = NodePath.join(home, "claude-work");
      const workTranscript = NodePath.join(workHome, "projects", "work.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(workTranscript), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.promise(() => NodeFSP.writeFile(workTranscript, claudeLine(2, 7)));
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-instances-test",
            home,
            settings: decodeServerSettings({
              ...settings,
              providerInstances: {
                claude_work: {
                  driver: "claudeAgent",
                  config: {},
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: workHome }],
                },
                claude_duplicate: { driver: "claudeAgent", config: settings.providers.claudeAgent },
              },
            }),
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(summary), 12);
      assert.strictEqual(summary.buckets.length, 2);
      assert.sameMembers(
        summary.buckets.map(
          (bucket) => summary.sources[bucket.sourceIndex!]?.fingerprint.resolvedHomePath,
        ),
        [NodePath.join(home, "claude", "projects"), NodePath.join(workHome, "projects")],
      );
    }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts appended usage on a rescan of a grown transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-grow-test", home, settings })),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const firstScanStarted = yield* Deferred.make<void>();
        const secondScanStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        let homeProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) =>
              fileSystem.exists(path).pipe(
                Effect.tap(() => {
                  if (path !== NodePath.join(home, "claude", ".claude", "projects"))
                    return Effect.void;
                  homeProbes += 1;
                  return Deferred.succeed(
                    homeProbes === 1 ? firstScanStarted : secondScanStarted,
                    undefined,
                  );
                }),
              ),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.await(releaseRates).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
              ),
            ),
          ),
        );

        const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(firstScanStarted);
        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(secondScanStarted);
        yield* Deferred.succeed(releaseRates, undefined);

        const original = yield* Fiber.join(first);
        const updated = yield* Fiber.join(second);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.closeTo(updated.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-price-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("shares one scan between concurrent identical requests", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-flight-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const [first, second] = yield* Effect.all(
        [service.readSummary(WINDOW), service.readSummary(WINDOW)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(first, second);
      assert.strictEqual(ratesFetches, 1);

      // A later request is fresh work again, not a stale cached answer.
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("refetches a rate table inside its TTL only when the client asks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-rates-refresh-test",
            home,
            settings,
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(first.pricing.status, "fresh");

      // Inside the daily TTL a plain rescan keeps the cached table.
      yield* TestClock.adjust(Duration.minutes(2));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);

      // An explicit refresh fetches again so a newly listed model gets priced.
      // A burst of refreshes shares that one fetch.
      const [refreshed] = yield* Effect.all([service.refreshRates, service.refreshRates], {
        concurrency: 2,
      });
      assert.strictEqual(ratesFetches, 2);
      assert.strictEqual(refreshed.status, "fresh");
      assert.strictEqual(refreshed.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-interruption-test", home, settings }),
        ),
      );

      let orphanedAt: number | undefined;
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        // Each candidate needs a distinct key because the broken case leaves
        // its entry in the service's private in-flight map. The invalid window
        // keeps the real scan synchronous once its detached fiber starts.
        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});

const decodeServerSettings = Schema.decodeSync(ServerSettingsContract);

it.layer(NodeServices.layer)("Usage transcript roots", (it) => {
  it.effect("matches Pi's standard and legacy app-name environment precedence", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      expect(resolvePiAgentDir({ HOME: "/home/pi" }, path)).toBe("/home/pi/.pi/agent");
      expect(resolvePiTranscriptDir({ HOME: "/home/pi" }, path)).toBe(
        "/home/pi/.pi/agent/sessions",
      );
      // Pi's own name wins when both its current and predecessor environment
      // variables are inherited by a long-lived server process.
      expect(
        resolvePiAgentDir(
          {
            HOME: "/home/pi",
            PI_CODING_AGENT_DIR: "/pi-agent",
            TAU_CODING_AGENT_DIR: "/tau-agent",
          },
          path,
        ),
      ).toBe("/pi-agent");
      expect(
        resolvePiAgentDir(
          { HOME: "/home/pi", PI_CODING_AGENT_DIR: "/pi-agent" },
          path,
          "~/configured-agent",
        ),
      ).toBe("/home/pi/configured-agent");
      expect(
        resolvePiTranscriptDir(
          { HOME: "/home/pi", PI_CODING_AGENT_DIR: "/pi-agent" },
          path,
          "~/configured-agent",
        ),
      ).toBe("/home/pi/configured-agent/sessions");
      expect(
        resolvePiTranscriptDir(
          { HOME: "/home/pi", TAU_CODING_AGENT_SESSION_DIR: "~/tau-sessions" },
          path,
        ),
      ).toBe("/home/pi/tau-sessions");
      expect(
        resolvePiTranscriptDir(
          { HOME: "/home/pi", PI_CODING_AGENT_SESSION_DIR: "relative-sessions" },
          path,
        ),
      ).toBe(path.resolve("relative-sessions"));
    }),
  );

  it.effect("uses the legacy Pi settings when no explicit default instance exists", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeServerSettings({
        providers: { pi: { agentDir: "~/legacy-agent" } },
      });

      expect(
        resolveConfiguredPiTranscriptDirs(settings, { HOME: "/home/pi" }, path).map(
          (directory) => directory.dir,
        ),
      ).toEqual([
        "/home/pi/legacy-agent/sessions",
        "/home/pi/legacy-agent",
        "/home/pi/legacy-agent/.pi-subagents/runs",
      ]);
    }),
  );

  it.effect("scans and de-duplicates roots from every explicit Pi instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeServerSettings({
        providers: { pi: { agentDir: "~/ignored-legacy-agent" } },
        providerInstances: {
          pi: {
            driver: "pi",
            config: { agentDir: "~/primary-agent" },
            environment: [{ name: "PI_CODING_AGENT_SESSION_DIR", value: "~/primary-sessions" }],
          },
          pi_work: {
            driver: "pi",
            config: { agentDir: "~/work-agent" },
            environment: [
              { name: "HOME", value: "/home/work" },
              { name: "PI_CODING_AGENT_SESSION_DIR", value: "~/work-sessions" },
            ],
          },
          pi_work_duplicate: {
            driver: "pi",
            config: { agentDir: "~/work-agent" },
            environment: [
              { name: "HOME", value: "/home/work" },
              { name: "PI_CODING_AGENT_SESSION_DIR", value: "~/work-sessions" },
            ],
          },
          codex: { driver: "codex", config: {} },
        },
      });

      const dirs = resolveConfiguredPiTranscriptDirs(settings, { HOME: "/home/pi" }, path);
      expect(dirs.map((directory) => directory.dir)).toEqual([
        "/home/pi/primary-sessions",
        "/home/pi/primary-agent",
        "/home/pi/primary-agent/.pi-subagents/runs",
        "/home/work/work-sessions",
        "/home/work/work-agent",
        "/home/work/work-agent/.pi-subagents/runs",
      ]);
    }),
  );

  it.effect("resolves and de-duplicates every configured provider transcript home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-homes-" });
      const claudePersonal = path.join(root, "claude-personal");
      const claudeWork = path.join(root, "claude-work");
      const codexPersonal = path.join(root, "codex-personal");
      const codexWork = path.join(root, "codex-work");
      const grokPersonal = path.join(root, "grok-personal");
      const grokWork = path.join(root, "grok-work");
      const claudePersonalProjects = path.join(claudePersonal, ".claude", "projects");
      yield* fileSystem.makeDirectory(claudePersonalProjects, { recursive: true });

      const settings = decodeServerSettings({
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", config: { homePath: claudePersonal } },
          claude_work: {
            driver: "claudeAgent",
            config: {},
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeWork }],
          },
          claude_duplicate: { driver: "claudeAgent", config: { homePath: claudePersonal } },
          codex: { driver: "codex", config: { homePath: codexPersonal } },
          codex_work: {
            driver: "codex",
            config: {},
            environment: [{ name: "CODEX_HOME", value: codexWork }],
          },
          grok: {
            driver: "grok",
            config: {},
            environment: [{ name: "GROK_HOME", value: grokPersonal }],
          },
          grok_work: {
            driver: "grok",
            config: {},
            environment: [{ name: "GROK_HOME", value: grokWork }],
          },
          pi: { driver: "pi", config: { agentDir: path.join(root, "pi") } },
        },
      });

      const directories = yield* resolveUsageTranscriptDirs(settings, { HOME: root });
      const nonPiDirectories = directories.filter(({ provider }) => provider !== "pi");

      expect(nonPiDirectories).toHaveLength(6);
      expect(nonPiDirectories).toEqual(
        expect.arrayContaining([
          { provider: "claude", dir: claudePersonalProjects },
          { provider: "claude", dir: path.join(claudeWork, "projects") },
          { provider: "codex", dir: path.join(codexPersonal, "sessions") },
          { provider: "codex", dir: path.join(codexWork, "sessions") },
          {
            provider: "grok",
            dir: path.join(grokPersonal, "sessions"),
            scanOptions: { fileName: "updates.jsonl" },
          },
          {
            provider: "grok",
            dir: path.join(grokWork, "sessions"),
            scanOptions: { fileName: "updates.jsonl" },
          },
        ]),
      );
    }),
  );

  it("reports partial read coverage without hiding complete scans", () => {
    expect(
      resolveUsageSourceReadCoverage({ unreadableFiles: 1, unreadableDirectories: 2 }),
    ).toEqual({
      status: "partial",
      message: "2 transcript directories could not be read; 1 transcript file could not be read.",
    });
    expect(
      resolveUsageSourceReadCoverage({ unreadableFiles: 0, unreadableDirectories: 0 }),
    ).toEqual({ status: "ok", message: null });
  });

  it.effect("coalesces overlapping standard and legacy Pi roots", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeServerSettings({
        providerInstances: {
          pi: {
            driver: "pi",
            config: { agentDir: "/tmp/pi-agent" },
            environment: [{ name: "PI_CODING_AGENT_SESSION_DIR", value: "/tmp/pi-agent" }],
          },
        },
      });

      const dirs = resolveConfiguredPiTranscriptDirs(settings, { HOME: "/home/pi" }, path);
      expect(dirs).toEqual([
        {
          provider: "pi",
          dir: "/tmp/pi-agent",
          scanOptions: { maxDepth: 1 },
          completeForCachePruning: false,
        },
        {
          provider: "pi",
          dir: "/tmp/pi-agent/.pi-subagents/runs",
          scanOptions: { maxDepth: 2, piSubagentSessionsOnly: true },
        },
      ]);
    }),
  );

  it.effect("finds one project-ancestor subagent root for repeated Pi sessions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-subagents-" });
      const project = path.join(root, "workspace", "project");
      const runs = path.join(root, "workspace", ".pi-subagents", "runs");
      yield* fileSystem.makeDirectory(project, { recursive: true });
      yield* fileSystem.makeDirectory(runs, { recursive: true });

      expect(yield* resolvePiSubagentTranscriptDirs([project, project])).toEqual([runs]);
    }),
  );
});
