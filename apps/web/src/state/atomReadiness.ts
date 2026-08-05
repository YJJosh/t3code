import type { Atom, AtomRegistry } from "effect/unstable/reactivity";

/** Waits without polling until an atom contains a value accepted by `isReady`. */
export function waitForAtomValue<A, Ready extends A>(
  registry: Pick<AtomRegistry.AtomRegistry, "get" | "subscribe">,
  atom: Atom.Atom<A>,
  isReady: (value: A) => value is Ready,
): Promise<Ready> {
  const current = registry.get(atom);
  if (isReady(current)) {
    return Promise.resolve(current);
  }

  return new Promise<Ready>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (value: A) => {
      if (settled || !isReady(value)) return;
      settled = true;
      const stop = unsubscribe;
      unsubscribe = null;
      stop?.();
      resolve(value);
    };

    // Subscribe, then read again to close the gap between the initial read and
    // listener registration. Also tolerate registries that notify immediately.
    const stop = registry.subscribe(atom, finish);
    if (settled) {
      stop();
      return;
    }
    unsubscribe = stop;
    finish(registry.get(atom));
  });
}
