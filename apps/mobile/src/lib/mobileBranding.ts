export type MobileBrand = "t3code" | "dulli";
export type MobileStageLabel = "Alpha" | "Dev" | "Nightly";

export function resolveMobileBrand(appBrand: unknown): MobileBrand {
  return appBrand === "dulli" ? "dulli" : "t3code";
}

export function resolveMobileBrandName(appBrand: unknown): "T3 Code" | "T3 Dulli" {
  return resolveMobileBrand(appBrand) === "dulli" ? "T3 Dulli" : "T3 Code";
}

export function resolveMobileBrandWord(appBrand: unknown): "Code" | "Dulli" {
  return resolveMobileBrand(appBrand) === "dulli" ? "Dulli" : "Code";
}

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Alpha";
}
