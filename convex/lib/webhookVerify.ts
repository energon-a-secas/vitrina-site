// Svix signature verification with Web Crypto and nothing else (plan section
// 3.3). Clerk delivers webhooks through Svix. The svix package would be the
// second dependency of a site whose package.json exists only for the Convex
// CLI, and the algorithm is short enough to own:
//
//   signed content  "<svix-id>.<svix-timestamp>.<raw body>"
//   key             base64 decode of the secret after its "whsec_" prefix
//   signature       base64 HMAC-SHA256, sent as "v1,<sig>", several separated by spaces
//
// tests/convex-webhook.test.mjs pins this against Svix's own published vector.
// crypto.subtle.verify does the comparison, so it is constant time; comparing
// base64 strings with === would not be.
//
// The timestamp window is not checked here. clerkWebhookCore owns it, with the
// clock passed in, so a test can hold the time still.

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function verifySvixSignature(
  secret: string,
  msgId: string,
  timestamp: string,
  rawBody: string,
  signatureHeader: string,
): Promise<boolean> {
  // Svix's own libraries accept the secret with or without its prefix. A
  // secret pasted without it would otherwise fail every delivery, and Svix
  // disables an endpoint after five days of failures.
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(encoded);
  } catch {
    return false;
  }
  if (keyBytes.length === 0) return false;

  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${msgId}.${timestamp}.${rawBody}`);

  // Several signatures appear while a secret is being rotated. Any one valid
  // v1 signature is enough; other versions are ignored rather than refused.
  for (const part of signatureHeader.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") continue;
    let signature: Uint8Array;
    try {
      signature = base64ToBytes(part.slice(comma + 1));
    } catch {
      continue;
    }
    if (await crypto.subtle.verify("HMAC", key, signature, signed)) return true;
  }
  return false;
}
