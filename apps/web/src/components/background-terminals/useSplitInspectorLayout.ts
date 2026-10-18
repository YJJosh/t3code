import { useEffect, useState, type RefObject } from "react";
import { observeResize } from "~/lib/observeResize";

/** Fit roster and terminal detail side by side only when the panel has room. */
export function useSplitInspectorLayout(rootRef: RefObject<HTMLDivElement | null>) {
  const [split, setSplit] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setSplit(root.getBoundingClientRect().width >= 640);
    update();
    return observeResize(root, update);
  }, [rootRef]);
  return split;
}
