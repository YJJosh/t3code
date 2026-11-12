import * as Schema from "effect/Schema";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export function retiredDulliInstanceIds(value: unknown): ReadonlyArray<string> {
  const instances =
    isRecord(value) && isRecord(value.providerInstances) ? value.providerInstances : {};
  return [
    "dulli",
    ...Object.entries(instances).flatMap(([id, instance]) =>
      isRecord(instance) && instance.driver === "dulli" ? [id] : [],
    ),
  ];
}

export function withoutRetiredDulliSettings(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const retired = new Set(retiredDulliInstanceIds(value));
  const cleanScope = (scope: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(scope).flatMap(([key, setting]) => {
        if (
          key.endsWith("ModelSelection") &&
          isRecord(setting) &&
          typeof setting.instanceId === "string" &&
          retired.has(setting.instanceId)
        )
          return [];
        if (key === "providerInstances" && isRecord(setting)) {
          return [
            [key, Object.fromEntries(Object.entries(setting).filter(([id]) => !retired.has(id)))],
          ];
        }
        return [[key, setting]];
      }),
    );
  const cleaned = cleanScope(value);
  if (isRecord(value.providers)) {
    cleaned.providers = Object.fromEntries(
      Object.entries(value.providers).filter(([driver]) => driver !== "dulli"),
    );
  }
  if (isRecord(value.projectSettingsOverrides)) {
    cleaned.projectSettingsOverrides = Object.fromEntries(
      Object.entries(value.projectSettingsOverrides).map(([id, scope]) => [
        id,
        isRecord(scope) ? cleanScope(scope) : scope,
      ]),
    );
  }
  return cleaned;
}
