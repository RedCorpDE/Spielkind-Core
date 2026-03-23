import crypto from "crypto";
import { config } from "../config.js";

/**
 * Regiondo signs each webhook payload with HMAC-SHA256 using your private key.
 * The signature is sent in the `X-Regiondo-Signature` header as a hex digest.
 *
 * Adjust the header name if Regiondo's docs specify a different one.
 */
export function verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | undefined
): boolean {
    if (!signatureHeader) return false;

    const expected = crypto
        .createHmac("sha256", config.regiondo.privateKey)
        .update(rawBody, "utf8")
        .digest("hex");

    // Constant-time comparison to prevent timing attacks
    try {
        return crypto.timingSafeEqual(
            Buffer.from(signatureHeader, "hex"),
            Buffer.from(expected, "hex")
        );
    } catch {
        // Buffer lengths differ → invalid signature
        return false;
    }
}