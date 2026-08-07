import { describe, expect, it } from "vite-plus/test";

import { extractAndroidCertificateSha256 } from "./extract-android-cert-sha256";

const DIGEST =
  "FE:2C:E6:5A:A7:EB:34:81:B1:F0:A0:0B:17:A5:0B:F2:04:E4:62:E6:B4:40:BE:01:75:6E:50:F0:70:AC:EB:DE";
const NORMALIZED_DIGEST = "fe2ce65aa7eb3481b1f0a00b17a50bf204e462e6b440be01756e50f070acebde";

describe("extractAndroidCertificateSha256", () => {
  it("reads the signer format emitted by local Android build-tools", () => {
    expect(
      extractAndroidCertificateSha256(
        `Verifies\nSigner #1 certificate SHA-256 digest: ${DIGEST}\n`,
      ),
    ).toBe(NORMALIZED_DIGEST);
  });

  it("reads the V2 signer format emitted by GitHub's Android build-tools", () => {
    expect(
      extractAndroidCertificateSha256(
        `Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${NORMALIZED_DIGEST}\n`,
      ),
    ).toBe(NORMALIZED_DIGEST);
  });

  it("does not confuse a public-key digest with the certificate digest", () => {
    expect(
      extractAndroidCertificateSha256(
        `V2 Signer: public key SHA-256 digest: ${NORMALIZED_DIGEST}\n`,
      ),
    ).toBeUndefined();
  });
});
