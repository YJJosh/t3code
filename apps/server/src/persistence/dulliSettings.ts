import * as Schema from "effect/Schema";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const PI_CONFIG_KEYS = new Set(["binaryPath", "launchArgs", "customModels"]);

// The old fork enabled Dulli unless settings said otherwise. Pi is off by default, so moved
// instances spell out `enabled`.
const DEFAULT_DULLI_ON_PI = { driver: "pi", displayName: "Pi (Dulli)", enabled: true };

/** Dulli instances keep their ids, so threads and model picks that name them stay valid. */
export function withDulliOnPi(
  value: unknown,
  options: { readonly addDefaultInstance?: boolean } = {},
): unknown {
  if (!isRecord(value)) return value;
  const instances = isRecord(value.providerInstances) ? value.providerInstances : {};
  if (options.addDefaultInstance === true && !("dulli" in instances)) {
    return withDulliOnPi({
      ...value,
      providerInstances: { ...instances, dulli: DEFAULT_DULLI_ON_PI },
    });
  }
  if (!isRecord(value.providerInstances)) return value;
  return {
    ...value,
    providerInstances: Object.fromEntries(
      Object.entries(value.providerInstances).map(([id, instance]) => {
        if (!isRecord(instance) || instance.driver !== "dulli") return [id, instance];
        const { config, ...rest } = instance;
        return [
          id,
          {
            ...rest,
            driver: "pi",
            displayName: typeof rest.displayName === "string" ? rest.displayName : "Pi (Dulli)",
            enabled: typeof rest.enabled === "boolean" ? rest.enabled : true,
            ...(isRecord(config)
              ? {
                  config: Object.fromEntries(
                    Object.entries(config).filter(([key]) => PI_CONFIG_KEYS.has(key)),
                  ),
                }
              : {}),
          },
        ];
      }),
    ),
  };
}
