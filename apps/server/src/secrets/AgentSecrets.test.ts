// @effect-diagnostics nodeBuiltinImport:off -- Subprocess fixtures use a fake op executable, never real credentials.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NodeCrypto from "node:crypto";
import * as Settings from "../serverSettings.ts";
import * as AgentSecrets from "./AgentSecrets.ts";
import { MaskedOutput } from "./secretProcess.ts";

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-secrets-" });
  const key = NodeCrypto.generateKeyPairSync("ed25519");
  const publicBytes = key.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const privateBytes = key.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const encode = (bytes: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const type = Buffer.from("ssh-ed25519");
  const pub = Buffer.concat([encode(type), encode(publicBytes)]);
  const checks = Buffer.alloc(8, 1);
  let priv = Buffer.concat([
    checks,
    encode(type),
    encode(publicBytes),
    encode(Buffer.concat([privateBytes, publicBytes])),
    encode(Buffer.alloc(0)),
  ]);
  const padding = Buffer.from(
    Array.from({ length: 8 - (priv.length % 8) }, (_, index) => index + 1),
  );
  priv = Buffer.concat([priv, padding]);
  const count = Buffer.from([0, 0, 0, 1]);
  const wire = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    encode(Buffer.from("none")),
    encode(Buffer.from("none")),
    encode(Buffer.alloc(0)),
    count,
    encode(pub),
    encode(priv),
  ]).toString("base64");
  const sshKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${wire.match(/.{1,70}/g)!.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const fixture = `#!${process.execPath}
const args = process.argv.slice(2);
const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
if (args.includes('list')) {
 process.stdout.write(JSON.stringify([{ id: 'item', title: 'Deployment', category: 'LOGIN' }]));
} else if (args.includes('get')) {
 process.stdout.write(JSON.stringify({ fields: [{ label: 'password', reference: 'op://vault-id/item/password', value: 'DO-NOT-RETURN' }] }));
} else if (args.at(-1).includes('missing')) {
 process.stderr.write('authentication failed ' + token); process.exitCode = 1;
} else if (args.at(-1).includes('private')) {
 process.stdout.write(${JSON.stringify(sshKey)});
} else {
 process.stdout.write(token === 'token-alpha' ? 'alpha-value' : token === 'token-beta' ? 'beta-value' : 'WRONG-TOKEN');
}
`;
  yield* fs.writeFileString(`${dir}/op`, fixture);
  yield* fs.chmod(`${dir}/op`, 0o700);
  const layer = AgentSecrets.layer.pipe(
    Layer.provide(
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          agentSecretVaults: { alpha: { token: "token-alpha" }, beta: { token: "token-beta" } },
        }),
      }),
    ),
  );
  return {
    dir,
    layer: layer.pipe(
      Layer.provide(
        Layer.succeed(HostProcess.Environment, {
          PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: dir,
          OP_SERVICE_ACCOUNT_TOKEN: "ambient-token",
          PI_1PASSWORD_AUTO_TOKEN: "ambient-token",
        }),
      ),
    ),
  };
});

it.live(
  "selects a token per vault, lists no values, refuses unshared references, and masks command output",
  () =>
    Effect.gen(function* () {
      const { dir, layer } = yield* harness;
      const fs = yield* FileSystem.FileSystem;
      const logs: unknown[] = [];
      const logger = Logger.make((entry) => {
        logs.push(entry.message);
      });
      yield* Effect.gen(function* () {
        const service = yield* AgentSecrets.AgentSecrets;
        assert.deepEqual(yield* service.list("alpha"), [
          {
            vault: "alpha",
            title: "Deployment",
            category: "LOGIN",
            fields: [{ label: "password", reference: "op://alpha/item/password" }],
          },
        ]);
        assert.equal((yield* service.list()).length, 2);
        const run = yield* service.run({
          cwd: dir,
          command:
            'printf "%s/%s/%s/%s" "$A" "$B" "${OP_SERVICE_ACCOUNT_TOKEN-unset}" "${PI_1PASSWORD_AUTO_TOKEN-unset}"; printf "%s" "$B" >&2',
          env: { A: "op://alpha/item/password", B: "op://beta/item/password" },
        });
        assert.equal(run.code, 0);
        assert.equal(run.stdout, "<concealed>/<concealed>/unset/unset");
        assert.equal(run.stderr, "<concealed>");
        assert.equal(
          (yield* Effect.flip(
            service.run({ cwd: dir, command: "exit 0", env: { A: "op://private/item/password" } }),
          )).reason,
          "unshared_vault",
        );
        assert.equal(
          (yield* Effect.flip(
            service.run({ cwd: dir, command: "exit 0", env: { A: "op://alpha/item" } }),
          )).reason,
          "invalid_reference",
        );
        assert.equal((yield* Effect.flip(service.list("private"))).reason, "unshared_vault");
        for (const name of ["OP_SERVICE_ACCOUNT_TOKEN", "SSH_AUTH_SOCK", "PATH", "bad-name"]) {
          assert.equal(
            (yield* Effect.flip(
              service.run({
                cwd: dir,
                command: "exit 0",
                env: { [name]: "op://alpha/item/password" },
              }),
            )).reason,
            "invalid_environment",
          );
        }
        const error = yield* Effect.flip(
          service.run({ cwd: dir, command: "exit 0", env: { A: "op://alpha/missing/password" } }),
        );
        assert.notInclude(JSON.stringify(error), "token-alpha");
        assert.equal(error.reason, "op_failed");
        const timed = yield* service.run({
          cwd: dir,
          command: `${process.execPath} -e 'process.stdin.resume();setInterval(()=>{},100000)'`,
          timeout: 1,
        });
        assert.isTrue(timed.timedOut);
        assert.notEqual(timed.code, 0);
        const ssh = yield* service.run({
          cwd: dir,
          command: 'ssh-add -l; printf "%s" "$SSH_AUTH_SOCK"',
          ssh_keys: ["op://alpha/item/private_key"],
          timeout: 5,
        });
        assert.equal(ssh.code, 0, ssh.stderr);
        assert.include(ssh.stdout, "ED25519");
        yield* fs.remove(`${dir}/op`);
        assert.equal((yield* Effect.flip(service.list("alpha"))).reason, "missing_binary");
        assert.notInclude(JSON.stringify(logs), "token-alpha");
        assert.notInclude(JSON.stringify(logs), "token-beta");
      }).pipe(
        Effect.provide(Layer.merge(layer, Logger.layer([logger], { mergeWithExisting: false }))),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("masks values split at every UTF-8 byte, overlaps, short values, and bounds output", () => {
  const secret = "pässword🔑";
  const output = new MaskedOutput([secret, "päss", "x"]);
  for (const byte of Buffer.from(`begin ${secret} x end`)) output.write(Buffer.from([byte]));
  assert.equal(output.finish(), "begin <concealed> <concealed> end");
  const bounded = new MaskedOutput(["secret"]);
  bounded.write(Buffer.from("a".repeat(50000) + "secret"));
  assert.isAtMost(bounded.finish().length, 30000);
  assert.notInclude(bounded.finish(), "secret");
});
