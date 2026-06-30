// index.ts — daily-reminder
//
// Scheduled via pg_cron (or Supabase's built-in Cron Jobs UI) to run every
// 15-30 minutes. Each run checks which users' local reminder_time falls in
// the current window, skips anyone who already logged a workout today or
// has reminders disabled, and sends a Consistency-focused push to everyone
// else.
//
// Deploy with:
//   supabase functions deploy daily-reminder
//
// Schedule via SQL (pg_cron, runs every 15 min):
//   select cron.schedule(
//     'daily-reminder-check',
//     '*/15 * * * *',
//     $$
//     select net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/daily-reminder',
//       headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb
//     );
//     $$
//   );
//
// Required secrets — same APNS_* as send-push, plus SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY (these last two are auto-injected by Supabase
// for Edge Functions, no need to set them manually).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendApnsPush } from "../send-push/apns.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Reminder messages — rotates so it doesn't feel robotic day after day.
const REMINDER_MESSAGES = [
  "💪 You haven't logged a workout today. Every workout counts toward your Consistency Rank.",
  "📈 One workout today could move you closer to your next Consistency Rank.",
  "🔥 Keep building your consistency this month.",
];

function pickMessage(userId: string): string {
  // Deterministic-but-varied: rotate based on day-of-year + a hash of the
  // user id, so the same user doesn't always see the same line, but a given
  // user/day combination is stable (useful if this function runs more than
  // once in the same reminder window due to retries).
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000,
  );
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return REMINDER_MESSAGES[(dayOfYear + hash) % REMINDER_MESSAGES.length];
}

Deno.serve(async (_req) => {
  try {
    const sb = createClient(supabaseUrl, supabaseServiceKey);
    const now = new Date();
    const nowHHMM = now.toISOString().slice(11, 16); // UTC "HH:MM" — see note below

    // NOTE ON TIMEZONES: profiles.reminder_time is stored as the user's
    // *local* preferred time (e.g. "18:00"), but this function compares
    // against UTC. For correctness, store each user's timezone offset
    // alongside reminder_time (e.g. a `tz_offset_minutes` column) and
    // adjust nowHHMM per-user, or — simpler for v1 — have the client send
    // reminder_time already converted to UTC when the user picks it in
    // their local timezone. The matching window below assumes reminder_time
    // is already in UTC; revisit this once real users span multiple zones.

    // Find users whose reminder window matches now (±7 min, since this
    // function runs every 15 min and we want to catch every user once)
    const { data: candidates, error } = await sb
      .from("profiles")
      .select("id, reminder_time")
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
      const diff = Math.abs((h * 60 + m) - (nh * 60 + nm));
      return diff <= 7;
    });

    if (withinWindow.length === 0) {
      return new Response(JSON.stringify({ checked: candidates.length, sent: 0 }), { status: 200 });
    }

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    let sentCount = 0;

    for (const profile of withinWindow) {
      // Skip if they've already logged a workout today
      const { count: todaysWorkouts } = await sb
        .from("workouts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", profile.id)
        .gte("ts", todayStart.toISOString());

      if (todaysWorkouts && todaysWorkouts > 0) continue;

      // Avoid double-sending if this function fires twice in the same
      // window (e.g. due to a retry) — check for a reminder notification
      // already created today.
      const { count: alreadyNotified } = await sb
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", profile.id)
        .eq("type", "reminder")
        .gte("created_at", todayStart.toISOString());

      if (alreadyNotified && alreadyNotified > 0) continue;

      const message = pickMessage(profile.id);

      // Store in the in-app notification center too, same as social events
      await sb.from("notifications").insert({
        user_id: profile.id,
        type: "reminder",
        title: "Workout reminder",
        body: message,
        data: {},
      });

      // Send the actual push
      const { data: tokens } = await sb
        .from("push_tokens")
        .select("token")
        .eq("user_id", profile.id);

      if (tokens && tokens.length > 0) {
        for (const { token } of tokens) {
          const result = await sendApnsPush(token, {
            title: "Lock In.",
            body: message,
          });
          if (result.shouldDeleteToken) {
            await sb.from("push_tokens").delete().eq("token", token);
          }
        }
      }
      sentCount++;
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
