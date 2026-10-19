/** The :D mark from assets/dulli/logo.svg, represented as paths for both clients. */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { DulliSettings } from "./settings.ts";

export const dulliClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("dulli"),
  label: "Dulli",
  settingsSchema: DulliSettings,
  icon: {
    viewBox: "0 0 1024 1024",
    fill: { light: "#ffffff", dark: "#ffffff" },
    paths: [
      {
        d: "M80 0H944Q1024 0 1024 80V944Q1024 1024 944 1024H80Q0 1024 0 944V80Q0 0 80 0Z",
        fill: { light: "#000000", dark: "#000000" },
      },
      {
        d: "M228 356H284Q300 356 300 372V428Q300 444 284 444H228Q212 444 212 428V372Q212 356 228 356ZM228 580H284Q300 580 300 596V652Q300 668 284 668H228Q212 668 212 652V596Q212 580 228 580Z",
      },
      {
        d: "M376 250H578C760 250 870 350 870 512S760 774 578 774H376V250ZM466 330V694H580C715 694 790 628 790 512S715 330 580 330H466Z",
        fillRule: "evenodd",
      },
    ],
  },
});
