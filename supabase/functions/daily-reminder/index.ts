// daily-reminder — single-file version for pasting directly into the
// Supabase Dashboard's Edge Function editor (Edge Functions > daily-reminder).
//
// Scheduled via pg_cron (job "daily-reminder-check") to run every 15 minutes.
// Checks which users' reminder_time (stored as UTC "HH:MM") falls in the
// current window, skips anyone who already logged a workout on their own
// calendar day (profiles.timezone) or has reminders disabled, and sends a
// Consistency-focused push to everyone else.
//
// Same secrets as send-push — APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID,
// APNS_PRIVATE_KEY, APNS_PRODUCTION. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase, no setup needed.
// APNS_PRODUCTION must be "true" for App Store / TestFlight builds; a
// mismatch makes APNs reject tokens as BadDeviceToken and they get deleted.

import { createClient } from "jsr:@supabase/supabase-js@2";

// ── APNs JWT signing + push sending (inlined, identical to send-push) ───

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

async function getApnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.iat < 60 * 50) {
    return cachedJwt.token;
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

interface PushPayload {
  title: string;
  body: string;
  badge?: number;
  data?: Record<string, unknown>;
}

async function sendApnsPush(
  deviceToken: string,
  payload: PushPayload,
): Promise<{ ok: boolean; status: number; reason: string; shouldDeleteToken: boolean }> {
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

  const reason = res.ok ? "" : await res.text();
  const shouldDeleteToken = res.status === 410 ||
    (res.status === 400 && reason.includes("BadDeviceToken"));

  return { ok: res.ok, status: res.status, reason, shouldDeleteToken };
}

// ── Reminder logic ────────────────────────────────────────────────────────

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const REMINDER_MESSAGES = [
  "💪 You haven't logged a workout today. Every workout counts toward your Consistency Rank.",
  "📈 One workout today could move you closer to your next Consistency Rank.",
  "🔥 Keep building your consistency this month.",
];

function pickMessage(userId: string): string {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000,
  );
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return REMINDER_MESSAGES[(dayOfYear + hash) % REMINDER_MESSAGES.length];
}

// Calendar date ("YYYY-MM-DD") of an instant in the user's timezone. Users
// who haven't opened an app version that saves their timezone fall back to UTC.
function localDate(d: Date, tz: string | null): string {
  try {
    return d.toLocaleDateString("en-CA", { timeZone: tz || "UTC" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

Deno.serve(async (_req) => {
  try {
    const sb = createClient(supabaseUrl, supabaseServiceKey);
    const now = new Date();
    const nowHHMM = now.toISOString().slice(11, 16); // UTC "HH:MM"

    const { data: candidates, error } = await sb
      .from("profiles")
      .select("id, reminder_time, timezone, last_reminded_on")
      .eq("reminder_enabled", true);

    if (error) {
      console.error("Failed to fetch candidate profiles:", error.message);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
    if (!candidates || candidates.length === 0) {
      return new Response(JSON.stringify({ checked: 0, sent: 0 }), { status: 200 });
    }

    const withinWindow = candidates.filter((p) => {
      if (!p.reminder_time) return false;
      const [h, m] = p.reminder_time.split(":").map(Number);
      const [nh, nm] = nowHHMM.split(":").map(Number);
      const raw = Math.abs((h * 60 + m) - (nh * 60 + nm));
      // Wrap around midnight so 23:55 and 00:00 count as 5 minutes apart.
      return Math.min(raw, 1440 - raw) <= 7;
    });

    if (withinWindow.length === 0) {
      return new Response(JSON.stringify({ checked: candidates.length, sent: 0 }), { status: 200 });
    }

    // 36h covers "today" in every timezone; each workout is then checked
    // against the user's own calendar day.
    const lookback = new Date(now.getTime() - 36 * 3600000);

    let sentCount = 0;

    for (const profile of withinWindow) {
      const today = localDate(now, profile.timezone);
      if (profile.last_reminded_on === today) continue;
      const { data: recent, error: wErr } = await sb
        .from("workouts")
        .select("ts")
        .eq("user_id", profile.id)
        .gte("ts", lookback.toISOString());
      if (wErr) {
        console.error("Workout lookup failed for", profile.id, wErr.message);
        continue;
      }
      if ((recent || []).some((w) => localDate(new Date(w.ts), profile.timezone) === today)) continue;

      const message = pickMessage(profile.id);

      // Keeps an in-app record when the notifications table exists; the push
      // below doesn't depend on it.
      await sb.from("notifications").insert({
        user_id: profile.id,
        type: "reminder",
        title: "Workout reminder",
        body: message,
        data: {},
      });

      const { data: tokens, error: tErr } = await sb
        .from("push_tokens")
        .select("token")
        .eq("user_id", profile.id);

      if (tErr) {
        console.error("Push token lookup failed for", profile.id, tErr.message);
        continue;
      }
      if (!tokens || tokens.length === 0) {
        console.log("No push tokens for", profile.id);
        continue;
      }

      let delivered = false;
      for (const { token } of tokens) {
        const result = await sendApnsPush(token, {
          title: "Lock In.",
          body: message,
        });
        if (result.ok) {
          delivered = true;
        } else {
          console.error("APNs push failed for", profile.id, result.status, result.reason);
        }
        if (result.shouldDeleteToken) {
          await sb.from("push_tokens").delete().eq("token", token);
        }
      }
      if (delivered) {
        sentCount++;
        await sb.from("profiles").update({ last_reminded_on: today }).eq("id", profile.id);
      }
    }

    return new Response(
      JSON.stringify({ checked: withinWindow.length, sent: sentCount }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("daily-reminder error:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
