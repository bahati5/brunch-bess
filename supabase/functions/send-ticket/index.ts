// Envoie l'e-mail « ton ticket est prêt » pour une réservation validée.
//
// Idempotent : l'e-mail part une seule fois (email_sent_at), quel que soit
// le nombre d'appels. Le site l'appelle après chaque validation (auto ou admin)
// et à l'ouverture d'un ticket validé, ce qui garantit l'envoi sans file d'attente.
//
// Corps : { ref, token }            → appel depuis la page de l'invité
//         { id, resend: true }      → renvoi forcé par un admin (JWT admin requis)
//
// L'envoi passe par un script Google Apps Script (compte Gmail), voir apps-script/Code.gs.
// Secrets : APPS_SCRIPT_URL (URL /exec du déploiement), APPS_SCRIPT_SECRET, SITE_URL
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const fcfa = (n: number) => n.toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, " ") + " FCFA";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));

  let query = db.from("reservations").select("*").eq("status", "validated");
  let force = false;

  if (body.id) {
    // Renvoi par un admin : on vérifie son JWT
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: user } = await db.auth.getUser(jwt);
    if (!user?.user) return json({ error: "auth" }, 401);
    const { data: admin } = await db.from("admins").select("user_id").eq("user_id", user.user.id).maybeSingle();
    if (!admin) return json({ error: "forbidden" }, 403);
    query = query.eq("id", body.id);
    force = body.resend === true;
  } else if (body.ref && body.token) {
    query = query.eq("ref", String(body.ref).toUpperCase()).eq("access_token", body.token);
  } else {
    return json({ error: "params" }, 400);
  }

  const { data: r, error: dbError } = await query.maybeSingle();
  if (dbError) return json({ sent: false, reason: "db", detail: dbError.message }, 500);
  if (!r) return json({ sent: false, reason: "not_validated" });
  if (!r.email) return json({ sent: false, reason: "no_email" });

  // Réserve l'envoi de façon atomique pour éviter les doublons
  if (!force) {
    const { data: claimed } = await db.from("reservations")
      .update({ email_sent_at: new Date().toISOString() })
      .eq("id", r.id).is("email_sent_at", null).select("id");
    if (!claimed?.length) return json({ sent: false, reason: "already_sent" });
  }

  const site = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  const link = `${site}/reservation.html?r=${encodeURIComponent(r.ref)}&t=${r.access_token}`;
  const places = r.quantity > 1 ? `${r.quantity} places` : "1 place";

  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#EAF5FD;font-family:Segoe UI,Arial,sans-serif;color:#13265C">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="background:#13265C;color:#F7C51E;padding:24px 28px;font-size:22px;font-weight:800;letter-spacing:.04em">GRAND BRUNCH RETROUVAILLES</td></tr>
<tr><td style="padding:28px">
<p style="font-size:18px;margin:0 0 12px">Bonjour ${esc(r.first_name)},</p>
<p style="margin:0 0 12px;line-height:1.55">Ton paiement de <b>${fcfa(r.amount)}</b> est confirmé. Ton ticket pour <b>${places}</b> est prêt !</p>
<p style="margin:0 0 20px;line-height:1.55">Tu y trouveras ton QR code d'entrée et <b>le lieu du brunch</b>. Garde-le sur ton téléphone ou télécharge-le en PDF.</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#F7C51E;color:#13265C;text-decoration:none;font-weight:800;letter-spacing:.08em;padding:14px 26px;border-radius:999px">VOIR MON TICKET</a></p>
<p style="margin:0;font-size:14px;color:#44527A">Référence : <b>${esc(r.ref)}</b><br>Samedi 31 octobre 2026, à partir de 12h</p>
</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:12px;color:#44527A">Ce lien est personnel : ne le partage pas, il donne accès à ton ticket.</td></tr>
</table></td></tr></table></body></html>`;

  // Apps Script répond par une redirection (302) vers le résultat : fetch la suit automatiquement
  let out: { ok?: boolean; error?: string } = {};
  try {
    const url = Deno.env.get("APPS_SCRIPT_URL") ?? "";
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) throw new Error("APPS_SCRIPT_URL invalide (doit finir par /exec)");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        secret: Deno.env.get("APPS_SCRIPT_SECRET"),
        to: r.email,
        name: "Grand Brunch Retrouvailles",
        subject: "Ton ticket pour le Grand Brunch Retrouvailles",
        html,
      }),
    });
    const text = await res.text();
    try { out = JSON.parse(text); }
    catch {
      // Une page HTML = le déploiement n'est pas accessible à « Tout le monde » ou l'URL est fausse
      out = { ok: false, error: `réponse non JSON (HTTP ${res.status}) : ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}` };
    }
  } catch (e) {
    out = { ok: false, error: String((e as Error).message ?? e) };
  }

  if (!out.ok) {
    console.error("send-ticket", r.ref, out.error);
    // Échec : on libère le verrou pour qu'un prochain appel retente l'envoi
    if (!force) await db.from("reservations").update({ email_sent_at: null }).eq("id", r.id);
    return json({ sent: false, reason: "provider", detail: out.error }, 502);
  }
  if (force) await db.from("reservations").update({ email_sent_at: new Date().toISOString() }).eq("id", r.id);
  await db.from("audit_log").insert({ actor: "système", action: "email", reservation_id: r.id, details: { to: r.email, force } });
  return json({ sent: true });
});
