// Ticket d'entrée : un seul modèle pour l'écran et le PDF (le PDF est une capture fidèle du ticket).
// Nécessite qrcode-generator ; html2canvas et jsPDF sont chargés à la demande pour le PDF.
(function(){
  var JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
  var H2C = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
  var BASE = (document.currentScript && document.currentScript.src || location.href).replace(/assets\/ticket\.js.*$/, "");

  function qrSvg(text){ var qr = qrcode(0, "M"); qr.addData(text); qr.make(); return qr.createSvgTag({cellSize:4, margin:1, scalable:true}); }

  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function field(label, value, cls){ var d = el("div", cls); d.append(el("dt", "", label), el("dd", "", value)); return d; }
  function fcfa(n){ return Number(n || 0).toLocaleString("fr-FR").replace(/ | /g, " ") + " FCFA"; }

  // t : {ref, ticket_code, first_name, last_name, promo, quantity, amount, venue:{name,address}}
  function render(t){
    var name = (t.first_name + " " + (t.last_name || "")).trim();
    var people = t.quantity + (t.quantity > 1 ? " personnes" : " personne");
    var venue = t.venue && t.venue.name ? t.venue.name + (t.venue.address ? " · " + t.venue.address : "") : "Communiqué très bientôt";

    var tk = el("article", "tk"); tk.setAttribute("aria-label", "Ticket d'entrée de " + name);

    var main = el("div", "tk-main");
    var head = el("div", "tk-head");
    var logo = el("img", "tk-logo"); logo.src = BASE + "img/logo-bessieux-96.png"; logo.alt = "";
    var brand = el("div", "tk-brand"); brand.append(el("span", "script", "Grand Brunch"), el("span", "caps", "Retrouvailles"));
    head.append(logo, brand, el("span", "tk-kind", "Ticket d'entrée"));

    var body = el("div", "tk-body");
    var mark = el("img", "tk-watermark"); mark.src = BASE + "img/logo-bessieux.png"; mark.alt = "";
    var title = el("p", "tk-title"); title.append(el("span", "", "BRUNCH"), el("em", "script", "Retrouvailles"));
    var grid = el("dl", "tk-grid");
    grid.append(
      field("Date", "Samedi 31 octobre 2026"), field("Heure", "À partir de 12h"), field("N° de ticket", t.ref),
      field("Titulaire", name), field("Promotion", t.promo), field("Valable pour", people),
      field("Lieu", venue, "tk-wide")
    );
    body.append(mark, el("p", "tk-over", "Lycée Mgr Bessieux · Promos 2018 · 2019 · 2020"), title, grid,
      el("p", "tk-motto script", "Bessieuxard un jour, Bessieuxard pour toujours !"));
    main.append(head, body);

    var stub = el("div", "tk-stub");
    var admit = el("p", "tk-admit"); admit.append("Admis · ", el("b", "", people));
    var qr = el("div", "tk-qr"); qr.innerHTML = qrSvg(t.ticket_code);
    stub.append(admit, qr, el("p", "tk-code", t.ticket_code), el("p", "tk-price", fcfa(t.amount)), el("p", "tk-hint script", "À présenter à l'entrée"));

    tk.append(main, stub);
    return tk;
  }

  function loadScript(src){
    return new Promise(function(ok, ko){ var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = ko; document.head.appendChild(s); });
  }
  function imagesReady(node){
    return Promise.all([].map.call(node.querySelectorAll("img"), function(img){
      return img.complete ? null : new Promise(function(ok){ img.onload = img.onerror = ok; });
    }));
  }

  // PDF : le ticket en version paysage, capturé en haute définition sur fond clair
  async function downloadPdf(t){
    await Promise.all([window.jspdf ? null : loadScript(JSPDF), window.html2canvas ? null : loadScript(H2C)]);
    var stage = el("div", "tk-stage");
    var ticket = render(t); ticket.classList.add("tk--wide");
    stage.append(ticket); document.body.append(stage);
    try {
      await imagesReady(stage);
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      var canvas = await window.html2canvas(stage, {scale:3, backgroundColor:"#EAF5FD", useCORS:true, logging:false});
      var w = 250, h = w * canvas.height / canvas.width;
      var doc = new window.jspdf.jsPDF({orientation:"landscape", unit:"mm", format:[w, h]});
      doc.setProperties({title:"Ticket Grand Brunch Retrouvailles · " + t.ref, subject:"Ticket d'entrée", author:"Grand Brunch Retrouvailles"});
      doc.addImage(canvas.toDataURL("image/jpeg", .95), "JPEG", 0, 0, w, h);
      doc.save("ticket-grand-brunch-" + t.ref + ".pdf");
    } finally { stage.remove(); }
  }

  window.Ticket = {qrSvg:qrSvg, render:render, downloadPdf:downloadPdf};
})();
