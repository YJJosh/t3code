#!/usr/bin/env node

const ANDROID_CERTIFICATE_SHA256_PATTERN =
  /^(?:Signer #1|V2 Signer:)\s+certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/imu;

export function extractAndroidCertificateSha256(output: string): string | undefined {
  const match = ANDROID_CERTIFICATE_SHA256_PATTERN.exec(output);
  return match?.[1]?.replaceAll(":", "").toLowerCase();
}

if (import.meta.main) {
  let output = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) output += chunk;

  const digest = extractAndroidCertificateSha256(output);
  if (digest === undefined) {
    console.error("Could not find the Android signer certificate SHA-256 digest.");
    process.exitCode = 1;
  } else {
    process.stdout.write(digest);
  }
}
