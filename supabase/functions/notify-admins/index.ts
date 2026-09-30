// Notifie les téléphones des admins (Web Push) quand un paiement est déclaré.
//
// Corps : { ref, token }   → appelé par la page de l'invité juste après sa déclaration.
//                            Une seule notification par déclaration (notified_at).
//         { test: true }   → notification de test vers les appareils de l'admin connecté (JWT admin).
//
// Secrets : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…), SITE_URL
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const fcfa = (n: number) => n.toLocaleString("fr-FR").replace(/ | /g, " ") + " FCFA";
const OPS: Record<string, string> = { airtel: "Airtel", moov: "Moov" };
// « +24174670566 » → « +241 74 67 05 66 »
const phone = (v: string | null) => {
  const d = String(v ?? "").replace(/\D/g, "");
  const group = (x: string) => (x.length % 2 ? [x.slice(0, 3), ...(x.slice(3).match(/../g) ?? [])] : x.match(/../g) ?? []).join(" ");
  return d.startsWith("241") ? "+241 " + group(d.slice(3)) : "+" + d;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")!, Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));
  const site = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");

  let payload: Record<string, unknown>;
  let subsQuery = db.from("push_subscriptions").select("endpoint, subscription");

  if (body.test) {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: user } = await db.auth.getUser(jwt);
    if (!user?.user) return json({ error: "auth" }, 401);
    subsQuery = subsQuery.eq("user_id", user.user.id);
    payload = { title: "Notifications activées", body: "Tu seras prévenu(e) ici à chaque paiement déclaré.", url: `${site}/admin/`, tag: "test" };
  } else if (body.ref && body.token) {
    const { data: r } = await db.from("reservations").select("*")
      .eq("ref", String(body.ref).toUpperCase()).eq("access_token", body.token).maybeSingle();
    if (!r || r.status !== "declared") return json({ sent: 0, reason: "not_declared" });
    // Une seule notification par déclaration, même si la page appelle plusieurs fois
    const { data: claimed } = await db.from("reservations").update({ notified_at: new Date().toISOString() })
      .eq("id", r.id).is("notified_at", null).select("id");
    if (!claimed?.length) return json({ sent: 0, reason: "already_notified" });
    payload = {
      title: `Paiement à vérifier · ${fcfa(r.amount)}`,
      body: `${r.first_name} ${r.last_name} (promo ${r.promo}) · ${r.quantity} place${r.quantity > 1 ? "s" : ""}\n${OPS[r.operator] ?? r.operator} depuis ${phone(r.payer_phone)} · ID ${r.txn_id}`,
      url: `${site}/admin/#${r.ref}`,
      tag: r.ref,
    };
  } else {
    return json({ error: "params" }, 400);
  }

  const { data: subs } = await subsQuery;
  let sent = 0;
  const gone: string[] = [];
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // Abonnement expiré ou révoqué : on le supprime
      if (code === 404 || code === 410) gone.push(s.endpoint);
      else console.error("push", code, (e as Error).message);
    }
  }));
  if (gone.length) await db.from("push_subscriptions").delete().in("endpoint", gone);
  return json({ sent, removed: gone.length, devices: subs?.length ?? 0 });
});
