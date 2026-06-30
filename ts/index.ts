// index.ts — send-push
//
// Triggered by a Supabase Database Webhook configured on the `notifications`
// table (event: INSERT). Looks up the recipient's device tokens and sends
// an APNs push for each one. Deletes any tokens APNs reports as dead.
//
// Deploy with:
//   supabase functions deploy send-push
//
// Configure the webhook in Supabase Dashboard:
//   Database > Webhooks > Create a new webhook
//     Table: notifications
//     Events: Insert
//     Type: HTTP Request → Edge Function → send-push
//
// Required secrets (set once):
//   supabase secrets set APNS_KEY_ID=xxxx APNS_TEAM_ID=xxxx \
//     APNS_BUNDLE_ID=com.lockin.app APNS_PRODUCTION=false \
//     APNS_PRIVATE_KEY="$(cat AuthKey_XXXX.p8)"

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendApnsPush } from "./apns.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    // Database Webhook payload shape: { type: "INSERT", table: "notifications", record: {...}, ... }
    const record = payload.record;
    if (!record || !record.user_id) {
      return new Response(JSON.stringify({ skipped: true, reason: "no record/user_id" }), { status: 200 });
    }

    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch this user's device tokens
    const { data: tokens, error: tokenErr } = await sb
      .from("push_tokens")
      .select("token")
      .eq("user_id", record.user_id);

    if (tokenErr) {
      console.error("Failed to fetch push tokens:", tokenErr.message);
      return new Response(JSON.stringify({ error: tokenErr.message }), { status: 500 });
    }
    if (!tokens || tokens.length === 0) {
      // User has no registered device — nothing to send, not an error.
      return new Response(JSON.stringify({ skipped: true, reason: "no tokens" }), { status: 200 });
    }

    // Unread count for the badge number on the app icon
    const { count: unreadCount } = await sb
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", record.user_id)
      .eq("read", false);

    const results = await Promise.all(
      tokens.map(async ({ token }) => {
        const result = await sendApnsPush(token, {
          title: record.title || "Lock In.",
          body: record.body,
          badge: unreadCount ?? 1,
          data: { notif_id: record.id, type: record.type },
        });
        if (result.shouldDeleteToken) {
          await sb.from("push_tokens").delete().eq("token", token);
        }
        return { token, ...result };
      }),
    );

    return new Response(JSON.stringify({ sent: results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("send-push error:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
