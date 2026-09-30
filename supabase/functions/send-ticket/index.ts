// Envoie l'e-mail « ton ticket est prêt » pour une réservation validée.
//
// Idempotent : l'e-mail part une seule fois (email_sent_at), quel que soit
// le nombre d'appels. Le site l'appelle après chaque validation (auto ou admin)
// et à l'ouverture d'un ticket validé, ce qui garantit l'envoi sans file d'attente.
//
// Corps : { ref, token }            → appel depuis la page de l'invité
//         { id, resend: true }      → renvoi forcé par un admin (JWT admin requis)
//
// L'e-mail reprend le ticket (même charte que le site) avec le QR code et le logo intégrés
// en pièces jointes « inline » : ils s'affichent même quand la messagerie bloque les images distantes.
// L'envoi passe par un script Google Apps Script (compte Gmail), voir apps-script/Code.gs.
// Secrets : APPS_SCRIPT_URL (URL /exec du déploiement), APPS_SCRIPT_SECRET, SITE_URL
import { createClient } from "npm:@supabase/supabase-js@2";
import QRCode from "npm:qrcode@1.5.4";
import { Buffer } from "node:buffer";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const fcfa = (n: number) => n.toLocaleString("fr-FR").replace(/ | /g, " ") + " FCFA";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const NAVY = "#13265C", SUN = "#F7C51E", SKY = "#EAF5FD", MUTED = "#5A678C";
const SANS = "Manrope,'Segoe UI',Arial,sans-serif";
const DISPLAY = "Anton,Impact,'Arial Narrow Bold',sans-serif";
const SCRIPT = "'Kaushan Script','Brush Script MT',cursive";

type Ticket = { name: string; first: string; ref: string; code: string; promo: string; people: string; amount: string; venue: string; link: string };

// Case « libellé / valeur » du ticket
const cell = (label: string, value: string, colspan = 1) =>
  `<td colspan="${colspan}" valign="top" style="padding:0 10px 12px 0;font-family:${SANS}">
    <div style="font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${MUTED}">${label}</div>
    <div style="font-size:15px;font-weight:800;color:${NAVY};padding-top:3px">${esc(value)}</div></td>`;

function emailHtml(t: Ticket, logoSrc: string) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<title>Ton ticket · Grand Brunch Retrouvailles</title>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Kaushan+Script&family=Manrope:wght@500;700;800&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${SKY};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Paiement confirmé : voici ton ticket d'entrée pour le samedi 31 octobre, avec le lieu.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SKY}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">

<tr><td style="padding:0 6px 18px;font-family:${SANS};font-size:15px;line-height:1.55;color:${NAVY}">
  Bonjour <b>${esc(t.first)}</b>,<br>ton paiement de <b>${t.amount}</b> est confirmé. Voici ton ticket d'entrée, garde-le précieusement !
</td></tr>

<tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate">
    <tr><td style="background:${NAVY};border-radius:18px 18px 0 0;padding:14px 18px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="46" valign="middle"><img src="${logoSrc}" width="42" height="42" alt="Lycée Mgr Bessieux" style="display:block;border-radius:50%;background:#fff;border:2px solid ${SUN}"></td>
        <td valign="middle" style="padding-left:10px;color:#fff;font-family:${SCRIPT};font-size:22px;line-height:1.1">Grand Brunch<br>
          <span style="font-family:${SANS};font-size:9px;font-weight:800;letter-spacing:4px;color:${SUN}">RETROUVAILLES</span></td>
        <td align="right" valign="middle" style="font-family:${SANS};font-size:10px;font-weight:800;letter-spacing:2px;color:${SUN}">TICKET<br>D'ENTRÉE</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#ffffff;padding:18px 20px 6px">
      <div style="font-family:${SANS};font-size:10px;font-weight:800;letter-spacing:2px;color:${MUTED}">LYCÉE MGR BESSIEUX · PROMOS 2018 · 2019 · 2020</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 14px"><tr>
        <td valign="bottom" style="font-family:${DISPLAY};font-size:54px;line-height:1;color:${NAVY};text-shadow:3px 3px 0 ${SUN}">BRUNCH</td>
        <td valign="bottom" style="padding:0 0 10px 8px;font-family:${SCRIPT};font-size:24px;color:${NAVY}">Retrouvailles</td>
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>${cell("Date", "Samedi 31 octobre 2026")}${cell("Heure", "À partir de 12h")}</tr>
        <tr>${cell("Titulaire", t.name)}${cell("Promotion", t.promo)}</tr>
        <tr>${cell("N° de ticket", t.ref)}${cell("Valable pour", t.people)}</tr>
        <tr>${cell("Lieu", t.venue, 2)}</tr>
      </table>
      <div style="font-family:${SCRIPT};font-size:15px;color:${NAVY};padding:0 0 14px">Bessieuxard un jour, Bessieuxard pour toujours !</div>
    </td></tr>
    <tr><td style="background:#ffffff;padding:0"><div style="border-top:3px dashed ${NAVY};height:0;line-height:0;font-size:0">&nbsp;</div></td></tr>
    <tr><td align="center" style="background:${SUN};border-radius:0 0 18px 18px;padding:18px 18px 20px">
      <div style="font-family:${SANS};font-size:10px;font-weight:800;letter-spacing:2px;color:${NAVY}">ADMIS · ${esc(t.people.toUpperCase())}</div>
      <img src="cid:qr" width="170" height="170" alt="QR code du ticket ${esc(t.code)}" style="display:block;margin:10px auto 6px;background:#fff;border:2px solid ${NAVY};border-radius:12px;padding:8px">
      <div style="font-family:Consolas,'Courier New',monospace;font-size:13px;font-weight:700;letter-spacing:3px;color:${NAVY}">${esc(t.code)}</div>
      <div style="font-family:${DISPLAY};font-size:28px;line-height:1.2;color:${NAVY};padding-top:4px">${t.amount}</div>
      <div style="font-family:${SCRIPT};font-size:16px;color:${NAVY}">À présenter à l'entrée</div>
    </td></tr>
  </table>
</td></tr>

<tr><td align="center" style="padding:24px 0 6px">
  <a href="${t.link}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2px;padding:15px 28px;border-radius:999px">VOIR MON TICKET EN LIGNE</a>
</td></tr>
<tr><td align="center" style="padding:8px 16px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED}">
  En ligne, tu peux aussi le télécharger en PDF. Ce ticket est personnel : ne partage pas ce lien.<br>
  Tu reçois cet e-mail car tu as réservé ta place au Grand Brunch Retrouvailles (réf. ${esc(t.ref)}).
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// Version texte : indispensable pour ne pas être classé en spam (un e-mail « tout HTML » est suspect)
function emailText(t: Ticket) {
  return `Bonjour ${t.first},

Ton paiement de ${t.amount} est confirmé. Voici ton ticket d'entrée pour le Grand Brunch Retrouvailles.

Titulaire : ${t.name}
Promotion : ${t.promo}
Valable pour : ${t.people}
N° de ticket : ${t.ref} (code ${t.code})
Date : samedi 31 octobre 2026, à partir de 12h
Lieu : ${t.venue}

Ton ticket avec le QR code d'entrée : ${t.link}

Ce ticket est personnel : ne partage pas ce lien.
Bessieuxard un jour, Bessieuxard pour toujours !`;
}

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
  const { data: s } = await db.from("settings").select("venue_name, venue_address").single();
  const t: Ticket = {
    name: `${r.first_name} ${r.last_name ?? ""}`.trim(),
    first: r.first_name,
    ref: r.ref,
    code: r.ticket_code,
    promo: r.promo,
    people: r.quantity > 1 ? `${r.quantity} personnes` : "1 personne",
    amount: fcfa(r.amount),
    venue: s?.venue_name ? s.venue_name + (s.venue_address ? " · " + s.venue_address : "") : "Communiqué très bientôt",
    link: `${site}/reservation.html?r=${encodeURIComponent(r.ref)}&t=${r.access_token}`,
  };

  // QR code et logo joints à l'e-mail (images « inline »)
  const inline: Record<string, string> = {};
  const qr: Buffer = await QRCode.toBuffer(t.code, { type: "png", width: 340, margin: 1, errorCorrectionLevel: "M", color: { dark: "#13265C", light: "#FFFFFF" } });
  inline.qr = qr.toString("base64");
  let logoSrc = `${site}/img/logo-bessieux-96.png`;
  try {
    const lg = await fetch(logoSrc);
    if (lg.ok) { inline.logo = Buffer.from(await lg.arrayBuffer()).toString("base64"); logoSrc = "cid:logo"; }
  } catch { /* le logo reste en lien distant */ }

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
        subject: `Ton ticket d'entrée – Grand Brunch Retrouvailles (${r.ref})`,
        html: emailHtml(t, logoSrc),
        text: emailText(t),
        inline,
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
