/**
 * Relais d'envoi d'e-mails pour la billetterie (Google Apps Script).
 *
 * La fonction Supabase « send-ticket » vérifie la réservation, puis poste ici
 * { secret, to, subject, html, text, name, inline } : le script envoie l'e-mail depuis le compte Gmail
 * qui l'a déployé. Quota Gmail gratuit : environ 100 destinataires par jour.
 *
 * - text   : version texte de l'e-mail (évite le classement en spam des e-mails « tout HTML »)
 * - inline : images jointes au message, référencées dans le HTML par « cid:nom » (QR code, logo)
 *
 * Installation : voir README.md, section « E-mails ».
 * Le secret se règle dans Paramètres du projet → Propriétés du script → SECRET.
 * Après chaque modification de ce code : Déployer → Gérer les déploiements → modifier → Nouvelle version.
 */
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'json' }); }

  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || body.secret !== secret) return reply({ ok: false, error: 'forbidden' });
  if (!body.to || !body.subject || !body.html) return reply({ ok: false, error: 'params' });

  if (MailApp.getRemainingDailyQuota() < 1) return reply({ ok: false, error: 'quota' });

  var message = {
    to: body.to,
    subject: body.subject,
    htmlBody: body.html,
    body: body.text || '',
    name: body.name || 'Grand Brunch Retrouvailles'
  };
  if (body.replyTo) message.replyTo = body.replyTo;
  if (body.inline) {
    message.inlineImages = {};
    Object.keys(body.inline).forEach(function (key) {
      message.inlineImages[key] = Utilities.newBlob(Utilities.base64Decode(body.inline[key]), 'image/png', key + '.png');
    });
  }
  MailApp.sendEmail(message);
  return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** À lancer une fois depuis l'éditeur pour autoriser l'envoi d'e-mails et vérifier le quota. */
function testerAutorisation() {
  Logger.log('Quota restant aujourd\'hui : ' + MailApp.getRemainingDailyQuota());
}
