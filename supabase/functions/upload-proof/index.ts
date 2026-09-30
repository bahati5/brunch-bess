// Reçoit la capture d'écran du paiement envoyée par l'invité.
//
// Corps (FormData) : ref, token, file (image, compressée côté navigateur)
// 1. vérifie la réservation (ref + jeton secret)
// 2. enregistre l'image dans le bucket privé « proofs » (lisible seulement par les admins)
// 3. passe la réservation en « à vérifier » avec l'empreinte SHA-256 (détection des captures réutilisées)
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX = 6 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const form = await req.formData().catch(() => null);
  const ref = String(form?.get("ref") ?? "").trim().toUpperCase();
  const token = String(form?.get("token") ?? "");
  const file = form?.get("file");
  if (!ref || !token || !(file instanceof File)) return json({ error: "params", hint: "Capture manquante." }, 400);
  if (!TYPES[file.type]) return json({ error: "type", hint: "Envoie une image (capture d'écran ou photo)." }, 400);
  if (file.size > MAX) return json({ error: "size", hint: "Image trop lourde (6 Mo maximum)." }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: r } = await db.from("reservations").select("id, status")
    .eq("ref", ref).eq("access_token", token).maybeSingle();
  if (!r) return json({ error: "not_found", hint: "Réservation introuvable." }, 404);
  if (["validated", "cancelled", "absent"].includes(r.status)) return json({ error: "status", hint: "Cette réservation ne peut plus être modifiée." }, 409);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  const path = `${ref}/${Date.now()}.${TYPES[file.type]}`;

  const up = await db.storage.from("proofs").upload(path, bytes, { contentType: file.type, upsert: false });
  if (up.error) return json({ error: "storage", hint: "La capture n'a pas pu être enregistrée. Réessaie.", detail: up.error.message }, 500);

  const { data, error } = await db.rpc("attach_proof", { p_ref: ref, p_token: token, p_path: path, p_hash: hash });
  if (error) {
    await db.storage.from("proofs").remove([path]);
    return json({ error: error.message, hint: error.hint ?? "Erreur lors de l'enregistrement." }, 400);
  }
  return json(data);
});
