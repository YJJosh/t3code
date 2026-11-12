/** Environment for an eval'd `worker_threads` worker that reports through `parentPort`. */
export function workerThreadEnvironment(environment: NodeJS.ProcessEnv | undefined) {
  const workerEnvironment = Object.fromEntries(
    Object.entries(environment ?? process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // Node's watch loader reports imports over the parent's IPC channel. In a
  // worker this either throws or sends watch messages into our result protocol.
  delete workerEnvironment.WATCH_REPORT_DEPENDENCIES;
  delete workerEnvironment.NODE_CHANNEL_FD;
  delete workerEnvironment.NODE_CHANNEL_SERIALIZATION_MODE;
  return workerEnvironment;
}
