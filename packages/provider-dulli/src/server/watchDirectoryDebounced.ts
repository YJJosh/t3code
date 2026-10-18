/**
 * Debounced directory watching shared by the server's config-file watchers.
 *
 * Editors emit multiple events per save (truncate, write, rename) and
 * `fs.watch` can fire before content has been flushed to disk, so events are
 * debounced before consumers re-read the changed file.
 *
 * @module stream/watchDirectoryDebounced
 */
import * as Duration from "effect/Duration";
import type * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

const DEFAULT_DEBOUNCE = Duration.millis(100);

export interface WatchDirectoryDebouncedOptions {
  readonly directory: string;
  /**
   * Keep only events for relevant paths. Platforms differ on whether
   * `event.path` is a bare file name or a full path, so predicates should
   * accept both forms.
   */
  readonly isRelevantPath?: ((eventPath: string) => boolean) | undefined;
  readonly debounce?: Duration.Input | undefined;
}

export function watchDirectoryDebounced(
  fs: FileSystem.FileSystem,
  options: WatchDirectoryDebouncedOptions,
): Stream.Stream<FileSystem.WatchEvent, PlatformError.PlatformError> {
  const isRelevantPath = options.isRelevantPath;
  const events = fs.watch(options.directory);
  const relevantEvents = isRelevantPath
    ? Stream.filter(events, (event) => isRelevantPath(event.path))
    : events;
  return Stream.debounce(relevantEvents, options.debounce ?? DEFAULT_DEBOUNCE);
}
