// QR code et PDF du ticket. Nécessite qrcode-generator et jsPDF (chargés à la demande pour le PDF).
(function(){
  var JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

  function makeQr(text){ var qr = qrcode(0, "M"); qr.addData(text); qr.make(); return qr; }

  function qrSvg(text){ return makeQr(text).createSvgTag({cellSize:4, margin:2, scalable:true}); }

  function loadScript(src){
    return new Promise(function(ok, ko){
      var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = ko; document.head.appendChild(s);
    });
  }

  // jsPDF standard fonts ne couvrent que le Latin-1 : on remplace les caractères hors table
  function latin(s){
    return String(s == null ? "" : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[  ]/g, " ").replace(/[^\x00-\xFF]/g, "");
  }

  // t : {ref, ticket_code, first_name, last_name, promo, quantity, amount, venue:{name,address,notes}}
  async function downloadPdf(t){
    if (!window.jspdf) await loadScript(JSPDF);
    var doc = new window.jspdf.jsPDF({unit:"mm", format:"a5"});
    var W = 148, navy = [19,38,92], sun = [247,197,30];

    doc.setFillColor.apply(doc, navy); doc.rect(0, 0, W, 62, "F");
    doc.setFillColor.apply(doc, sun); doc.rect(0, 62, W, 3, "F");
    doc.setTextColor.apply(doc, sun); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.text("BESSIEUX ALUMNI  -  PROMOS 2018 - 2019 - 2020", 14, 16, {charSpace:.6});
    doc.setTextColor(255, 255, 255); doc.setFontSize(24);
    doc.text("GRAND BRUNCH", 14, 32);
    doc.setFont("helvetica", "normal"); doc.setFontSize(13);
    doc.text("des retrouvailles", 14, 40);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text("Samedi 31 octobre 2026  -  à partir de 12h", 14, 53);

    doc.setTextColor.apply(doc, navy);
    doc.setFontSize(8); doc.setFont("helvetica", "bold");
    doc.text("TITULAIRE", 14, 78, {charSpace:.5});
    doc.setFontSize(16); doc.text(latin(t.first_name + " " + t.last_name), 14, 86, {maxWidth:W - 28});
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    doc.text(latin("Promotion " + t.promo), 14, 93);

    doc.setFont("helvetica", "bold"); doc.setFontSize(8);
    doc.text("VALABLE POUR", 14, 105, {charSpace:.5});
    doc.text("RÉFÉRENCE", 80, 105, {charSpace:.5});
    doc.setFontSize(15);
    doc.text(t.quantity + (t.quantity > 1 ? " personnes" : " personne"), 14, 113);
    doc.text(latin(t.ref), 80, 113);

    // QR dessiné module par module : net à toutes les tailles
    var qr = makeQr(t.ticket_code), n = qr.getModuleCount(), size = 52, x0 = (W - size) / 2, y0 = 124, c = size / n;
    doc.setFillColor(255, 255, 255); doc.setDrawColor(213, 227, 241); doc.roundedRect(x0 - 5, y0 - 5, size + 10, size + 16, 3, 3, "FD");
    doc.setFillColor.apply(doc, navy);
    for (var r = 0; r < n; r++) for (var col = 0; col < n; col++) if (qr.isDark(r, col)) doc.rect(x0 + col * c, y0 + r * c, c + .02, c + .02, "F");
    doc.setFont("courier", "bold"); doc.setFontSize(11);
    doc.text(t.ticket_code.split("").join(" "), W / 2, y0 + size + 7, {align:"center"});

    if (t.venue && t.venue.name){
      doc.setFillColor(255, 229, 138); doc.roundedRect(10, 188, W - 20, t.venue.address ? 15 : 10, 3, 3, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(11);
      doc.text(latin("Lieu : " + t.venue.name), 14, 194.5, {maxWidth:W - 28});
      if (t.venue.address){ doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(latin(t.venue.address), 14, 200, {maxWidth:W - 28}); }
    }
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(68, 82, 122);
    doc.text("Ticket personnel. Présente le QR code à l'entrée : chaque place ne sert qu'une fois.", W / 2, 207, {align:"center"});

    doc.save("ticket-brunch-bessieux-" + t.ref + ".pdf");
  }

  window.Ticket = {qrSvg:qrSvg, downloadPdf:downloadPdf};
})();
