// apns.ts — shared helper for signing APNs JWTs and sending pushes via HTTP/2.
// Used by both send-push (per-notification) and daily-reminder (cron) functions.

// ── Required environment variables (set via `supabase secrets set`) ──
// APNS_KEY_ID        — the 10-character Key ID from Apple Developer > Keys
// APNS_TEAM_ID        — your Apple Developer Team ID
// APNS_BUNDLE_ID      — your app's bundle id, e.g. com.lockin.app
// APNS_PRIVATE_KEY    — the full contents of the .p8 file (including the
//                        -----BEGIN PRIVATE KEY----- / -----END----- lines)
// APNS_PRODUCTION     — "true" for App Store builds, "false"/unset for
//                        Sandbox (Xcode debug builds / TestFlight)

let cachedJwt: { token: string; iat: number } | null = null;

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importApnsKey(pem: string): Promise<CryptoKey> {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

// APNs JWTs are valid up to 1 hour — cache and reuse rather than signing
// a fresh one for every push, since signing has real (if small) cost.
async function getApnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.iat < 60 * 50) {
    return cachedJwt.token; // reuse if under 50 minutes old
  }

  const keyId = Deno.env.get("APNS_KEY_ID")!;
  const teamId = Deno.env.get("APNS_TEAM_ID")!;
  const privateKeyPem = Deno.env.get("APNS_PRIVATE_KEY")!;

  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: now }));
  const unsigned = `${header}.${payload}`;

  const key = await importApnsKey(privateKeyPem);
  const sigBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  const signature = base64url(sigBuffer);

  const token = `${unsigned}.${signature}`;
  cachedJwt = { token, iat: now };
  return token;
}

export interface PushPayload {
  title: string;
  body: string;
  badge?: number;
  data?: Record<string, unknown>;
}

// Sends a single push to a single device token. Returns true on success.
// Callers should treat APNs "BadDeviceToken"/410 responses as a signal to
// delete the stale token from push_tokens (handled by the caller, not here,
// since this module shouldn't need a Supabase client dependency).
export async function sendApnsPush(
  deviceToken: string,
  payload: PushPayload,
): Promise<{ ok: boolean; status: number; shouldDeleteToken: boolean }> {
  const bundleId = Deno.env.get("APNS_BUNDLE_ID")!;
  const isProd = Deno.env.get("APNS_PRODUCTION") === "true";
  const host = isProd
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";

  const jwt = await getApnsJwt();

  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
    },
    ...(payload.data || {}),
  });

  const res = await fetch(`${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      "authorization": `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body,
  });

  // 400 BadDeviceToken / 410 Unregistered → token is dead, caller should
  // remove it from push_tokens so we stop wasting calls on it.
  const shouldDeleteToken = res.status === 410 ||
    (res.status === 400 && (await res.clone().text()).includes("BadDeviceToken"));

  return { ok: res.ok, status: res.status, shouldDeleteToken };
}
