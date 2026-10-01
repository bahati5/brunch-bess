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

const fcfa = (n: number) => n.toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, " ") + " FCFA";
const OPS: Record<string, string> = { airtel: "Airtel", moov: "Moov" };
// « +241XXXXXXXX » → « +241 XX XX XX XX »
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
  let subsQuery = db.from("push_subscriptions").select("endpoint, subscription, device");

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
    const detail = r.proof_path ? "📷 Capture reçue"
      : r.txn_id ? `${OPS[r.operator] ?? r.operator} depuis ${phone(r.payer_phone)} · ID ${r.txn_id}`
      : "Sans capture : vérifie avec le nom et le montant";
    payload = {
      title: `Paiement à vérifier · ${fcfa(r.amount)}`,
      body: `${`${r.first_name} ${r.last_name}`.trim()} (promo ${r.promo}) · ${r.quantity} place${r.quantity > 1 ? "s" : ""}\n${detail}`,
      url: `${site}/admin/#${r.ref}`,
      tag: r.ref,
    };
  } else {
    return json({ error: "params" }, 400);
  }

  // Test « appli fermée » : on attend quelques secondes pour laisser l'admin quitter l'appli
  if (body.test && body.delay) await new Promise((ok) => setTimeout(ok, Math.min(Number(body.delay) || 0, 20) * 1000));

  const { data: subs } = await subsQuery;
  let sent = 0;
  const gone: string[] = [];
  // Résultat appareil par appareil (affiché dans l'admin lors d'un test)
  const results: { device: string; service: string; ok: boolean; status?: number; error?: string }[] = [];
  await Promise.all((subs ?? []).map(async (s) => {
    const service = s.endpoint.includes("push.apple.com") ? "Apple" : s.endpoint.includes("googleapis.com") ? "Google" : s.endpoint.includes("mozilla") ? "Mozilla" : "autre";
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      sent++;
      results.push({ device: s.device ?? "appareil", service, ok: true });
    } catch (e) {
      const err = e as { statusCode?: number; body?: string; message?: string };
      // Abonnement expiré ou révoqué : on le supprime
      if (err.statusCode === 404 || err.statusCode === 410) gone.push(s.endpoint);
      console.error("push", service, err.statusCode, err.body ?? err.message);
      results.push({ device: s.device ?? "appareil", service, ok: false, status: err.statusCode, error: String(err.body || err.message || "").slice(0, 160) });
    }
  }));
  if (gone.length) await db.from("push_subscriptions").delete().in("endpoint", gone);
  return json({ sent, removed: gone.length, devices: subs?.length ?? 0, results });
});
