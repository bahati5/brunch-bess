/**
 * Relais d'envoi d'e-mails pour la billetterie (Google Apps Script).
 *
 * La fonction Supabase « send-ticket » vérifie la réservation, puis poste ici
 * { secret, to, subject, html, name } : le script envoie l'e-mail depuis le compte Gmail
 * qui l'a déployé. Quota Gmail gratuit : environ 100 destinataires par jour.
 *
 * Installation : voir README.md, section « E-mails ».
 * Le secret se règle dans Paramètres du projet → Propriétés du script → SECRET.
 */
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'json' }); }

  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || body.secret !== secret) return reply({ ok: false, error: 'forbidden' });
  if (!body.to || !body.subject || !body.html) return reply({ ok: false, error: 'params' });

  if (MailApp.getRemainingDailyQuota() < 1) return reply({ ok: false, error: 'quota' });

  MailApp.sendEmail({
    to: body.to,
    subject: body.subject,
    htmlBody: body.html,
    name: body.name || 'Grand Brunch Retrouvailles'
  });
  return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** À lancer une fois depuis l'éditeur pour autoriser l'envoi d'e-mails et vérifier le quota. */
function testerAutorisation() {
  Logger.log('Quota restant aujourd\'hui : ' + MailApp.getRemainingDailyQuota());
}
