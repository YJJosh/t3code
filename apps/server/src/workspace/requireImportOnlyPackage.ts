import * as NodeURL from "node:url";

// Requires a package even when its `exports` map only has an `import`
// condition, which makes a plain `require` throw ERR_PACKAGE_PATH_NOT_EXPORTED.
// Falls back to requiring the file `import` resolves to; Node can `require` an
// ES module, so it is the same module either way. Pass the caller's
// `import.meta.resolve` so both lookups start from the same place.
export function requireImportOnlyPackage<T>(
  requireFrom: NodeJS.Require,
  resolveImport: (specifier: string) => string,
  specifier: string,
): T {
  try {
    return requireFrom(specifier);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    return requireFrom(NodeURL.fileURLToPath(resolveImport(specifier)));
  }
}
