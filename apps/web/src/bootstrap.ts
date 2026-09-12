import { APP_DISPLAY_NAME } from "./branding";
import { showBootError } from "./lib/bootError";

document
  .getElementById("boot-shell-card")
  ?.setAttribute("aria-label", `${APP_DISPLAY_NAME} splash screen`);
document.getElementById("boot-shell-logo")?.setAttribute("alt", APP_DISPLAY_NAME);
document.title = APP_DISPLAY_NAME;

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
void import("./main").then(({ startup }) => startup).catch(showBootError);
