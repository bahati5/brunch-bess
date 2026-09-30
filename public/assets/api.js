// Client Supabase et utilitaires partagés par toutes les pages.
// Nécessite supabase-js (UMD) et config.js chargés avant.
(function(){
  var cfg = window.BRUNCH_CONFIG || {};
  var configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  var sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  var TZ = "Africa/Libreville";
  var STORE = "brunch-bessieux:resa";

  function fcfa(n){ return Number(n || 0).toLocaleString("fr-FR").replace(/ | /g," ") + " FCFA"; }

  function dateTime(iso){
    return new Date(iso).toLocaleString("fr-FR", {timeZone:TZ, weekday:"long", day:"numeric", month:"long", hour:"2-digit", minute:"2-digit"});
  }
  function time(iso){
    return new Date(iso).toLocaleTimeString("fr-FR", {timeZone:TZ, hour:"2-digit", minute:"2-digit"});
  }

  // Les RPC lèvent « CODE » avec un hint lisible : on affiche le hint
  function errorText(err){
    if (!err) return "";
    if (err.hint) return err.hint;
    if (/fetch|network/i.test(err.message || "")) return "Connexion impossible. Vérifie ta connexion internet et réessaie.";
    return "Une erreur est survenue. Réessaie dans un instant.";
  }

  async function rpc(name, args){
    if (!sb) throw {hint:"La billetterie n'est pas encore configurée."};
    var res = await sb.rpc(name, args || {});
    if (res.error) throw res.error;
    return res.data;
  }

  // Déclenche l'e-mail du ticket (idempotent côté serveur, les erreurs sont ignorées)
  function sendTicket(body){
    if (!sb) return Promise.resolve();
    return sb.functions.invoke("send-ticket", {body:body}).catch(function(){});
  }

  // Prévient les téléphones des admins d'un paiement déclaré (idempotent côté serveur)
  function notifyAdmins(ref, token){
    if (!sb) return Promise.resolve();
    return sb.functions.invoke("notify-admins", {body:{ref:ref, token:token}}).catch(function(){});
  }

  // Mémorise la dernière réservation sur cet appareil (confort uniquement)
  function remember(ref, token){ try { localStorage.setItem(STORE, JSON.stringify({ref:ref, token:token})); } catch(e){} }
  function recall(){ try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch(e){ return null; } }
  function forget(){ try { localStorage.removeItem(STORE); } catch(e){} }

  // Numéros de téléphone
  // Gabon (+241) : les comptes WhatsApp gardent le format de leur création, souvent avec le 0
  // (« +241 0XX XX XX XX ») ou l'ancien numéro à 8 chiffres (« +241 0X XX XX XX »).
  // Aucun site ne peut vérifier le bon format : on garde donc le numéro tel que l'invité le tape
  // (recopié depuis son profil WhatsApp) en ajoutant seulement l'indicatif, pour un seul bouton WhatsApp fiable.
  function normPhone(v){
    var s = String(v || "").trim().replace(/[^\d+]/g, "");
    if (s.indexOf("00") === 0) s = "+" + s.slice(2);
    if (s.charAt(0) === "+") return s;
    if (s.indexOf("241") === 0 && s.length >= 11) return "+" + s;
    if (/^0\d{7,8}$/.test(s)) return "+241" + s;          // 0XXXXXXXX → +2410XXXXXXXX · 0XXXXXXX → +2410XXXXXXX
    if (/^[1-9]\d{7}$/.test(s)) return "+241" + s;        // XXXXXXXX   → +241XXXXXXXX
    return s;
  }
  function phoneError(v){
    var s = normPhone(v);
    if (!s) return "Indique un numéro.";
    if (s.charAt(0) !== "+") return "Numéro incomplet : tape-le comme dans WhatsApp, par exemple 0XX XX XX XX ou +33 6 12 34 56 78.";
    if (s.indexOf("+241") === 0 && !/^\+241(\d{8}|0\d{8})$/.test(s)) return "Un numéro gabonais a 9 chiffres : 0XX XX XX XX.";
    if (!/^\+\d{8,15}$/.test(s)) return "Ce numéro n'a pas le bon nombre de chiffres.";
    return "";
  }
  function group(x){ var out = []; if (x.length % 2){ out.push(x.slice(0, 3)); x = x.slice(3); } for (var i = 0; i < x.length; i += 2) out.push(x.slice(i, i + 2)); return out.join(" "); }
  function fmtPhone(v){
    var d = String(v || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.indexOf("241") === 0) return "+241 " + group(d.slice(3));
    if (d.indexOf("33") === 0 && d.length === 11) return "+33 " + d.slice(2, 3) + " " + group(d.slice(3));
    return (String(v).trim().charAt(0) === "+" ? "+" : "") + group(d);
  }
  // Autre écriture WhatsApp d'un numéro gabonais (avec / sans le 0), ou null
  function waAlt(v){
    var d = String(v || "").replace(/\D/g, "");
    if (/^241[1-9]\d{7}$/.test(d)) return "2410" + d.slice(3);
    if (/^2410\d{8}$/.test(d)) return "241" + d.slice(4);
    return null;
  }
  // Aperçu sous un champ téléphone : montre le numéro tel qu'il sera enregistré
  function phonePreview(input, out){
    function upd(){
      var v = input.value.trim(), err = v ? phoneError(v) : "";
      out.textContent = !v ? "" : err ? err : "Numéro enregistré : " + fmtPhone(normPhone(v));
      out.classList.toggle("bad", !!err);
    }
    input.addEventListener("input", upd); input.addEventListener("blur", upd); upd();
  }

  function resaUrl(ref, token){ return "reservation.html?r=" + encodeURIComponent(ref) + "&t=" + encodeURIComponent(token); }

  function waLink(phone, text){
    return "https://wa.me/" + String(phone || "").replace(/[^0-9]/g, "") + (text ? "?text=" + encodeURIComponent(text) : "");
  }

  function copy(text){
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly",""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } finally { t.remove(); }
    return Promise.resolve();
  }

  window.Brunch = {sb:sb, configured:configured, TZ:TZ, fcfa:fcfa, dateTime:dateTime, time:time, errorText:errorText,
    rpc:rpc, sendTicket:sendTicket, remember:remember, recall:recall, forget:forget, resaUrl:resaUrl, waLink:waLink, copy:copy,
    normPhone:normPhone, phoneError:phoneError, fmtPhone:fmtPhone, waAlt:waAlt, phonePreview:phonePreview, notifyAdmins:notifyAdmins};
})();
