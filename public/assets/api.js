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

  // Mémorise la dernière réservation sur cet appareil (confort uniquement)
  function remember(ref, token){ try { localStorage.setItem(STORE, JSON.stringify({ref:ref, token:token})); } catch(e){} }
  function recall(){ try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch(e){ return null; } }
  function forget(){ try { localStorage.removeItem(STORE); } catch(e){} }

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
    rpc:rpc, sendTicket:sendTicket, remember:remember, recall:recall, forget:forget, resaUrl:resaUrl, waLink:waLink, copy:copy};
})();
