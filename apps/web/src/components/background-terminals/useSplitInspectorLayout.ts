import { useEffect, useState, type RefObject } from "react";
import { observeResize } from "~/lib/observeResize";

/** Fit roster and terminal detail side by side only when the panel has room. */
export function useSplitInspectorLayout(rootRef: RefObject<HTMLDivElement | null>) {
  const [split, setSplit] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the mounted panel’s DOM width to choose a layout that fits it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setSplit(root.getBoundingClientRect().width >= 640);
    update();
    return observeResize(root, update);
  }, [rootRef]);
  return split;
}
