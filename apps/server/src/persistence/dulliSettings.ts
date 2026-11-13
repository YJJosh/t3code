import * as Schema from "effect/Schema";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const PI_CONFIG_KEYS = new Set(["binaryPath", "launchArgs", "customModels"]);

/** Dulli instances keep their ids, so threads and model picks that name them stay valid. */
export function withDulliOnPi(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.providerInstances)) return value;
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
