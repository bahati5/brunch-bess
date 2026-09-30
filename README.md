# Grand Brunch des retrouvailles — billetterie

Invitation digitale + billetterie avec paiement Airtel Money / Moov Money, sans agrégateur.

## Parcours

1. L'invité remplit la fiche sur l'invitation → réservation `BB-XXXXX`, places **bloquées 2 h** (réglable).
2. La page de suivi affiche le numéro Airtel / Moov, le montant exact et la référence.
3. Après le transfert, l'invité déclare l'opérateur, le numéro payeur et l'**ID de transaction** du SMS.
4. Si un SMS reçu correspond (même opérateur, même ID, même montant) → **validation automatique**.
   Sinon la réservation apparaît dans l'admin « À vérifier » : un admin compare avec le téléphone et valide ou refuse.
5. Validée → ticket groupé (QR code, N places) sur la page de suivi, PDF téléchargeable, e-mail automatique, lieu révélé.
6. Jour J → `admin/scan.html` scanne le QR et fait entrer 1 à N personnes.

Garde-fous : un ID de transaction ne sert qu'une fois, pas de survente (verrou SQL), le lieu n'est jamais envoyé
au navigateur tant que le ticket n'est pas validé, aucune table n'est lisible par le public (RLS + RPC uniquement).

## Arborescence

```
public/                     site statique (à déployer tel quel)
  index.html                invitation (maquette d'origine + fiche branchée)
  reservation.html          suivi : paiement → déclaration → vérification → ticket
  admin/index.html          tableau de bord admin
  admin/scan.html           contrôle des entrées
  assets/config.js          ← URL + clé anon Supabase à renseigner
supabase/
  migrations/…sql           schéma, RLS, RPC
  functions/send-ticket/    e-mail du ticket (vérifie la réservation, envoie via Apps Script)
apps-script/Code.gs         relais d'envoi Gmail (Google Apps Script)
```

La maquette d'origine est conservée à la racine, non modifiée.

## Mise en service

Tout se fait depuis les interfaces web, sans installer d'outil.

### 1. Créer le projet Supabase
1. https://supabase.com → se connecter avec GitHub → **New project**.
2. Nom `brunch-bessieux`, mot de passe de base de données (à garder), région **West EU (Ireland)** ou **Central EU (Frankfurt)**.
3. Attendre ~2 min que le projet soit prêt.

### 2. Créer la base
1. Menu **SQL Editor** → **New query**.
2. Exécuter **dans l'ordre** chaque fichier de `supabase/migrations/` (coller → **Run**) : résultat attendu « Success. No rows returned ».

### 3. Créer les comptes admin
1. **Authentication → Users → Add user → Create new user** : e-mail + mot de passe, cocher **Auto Confirm User**.
2. Dans **SQL Editor**, en remplaçant l'e-mail et le prénom :
   ```sql
   insert into admins (user_id, name)
   select id, 'Prénom' from auth.users where email = 'admin@exemple.com';
   ```
   Résultat attendu : « 1 row ». « 0 rows » = aucun compte avec cet e-mail.
3. Répéter pour chaque admin. Vérifier : `select a.name, u.email from admins a join auth.users u on u.id = a.user_id;`
4. **Authentication → Sign In / Providers** : désactiver **Allow new users to sign up** (seuls les comptes créés à la main peuvent se connecter).

### 4. Brancher le site
1. **Project Settings → API Keys** (ou bouton **Connect** en haut) : copier l'**URL du projet** et la clé **publishable** (ou `anon` dans l'onglet *Legacy*).
2. Les coller dans `public/assets/config.js`, commit, push. Ces deux valeurs sont publiques par nature.

### 5. E-mails via Google Apps Script
1. Avec le compte Gmail qui enverra les tickets : https://script.google.com → **Nouveau projet**, nommé « Billetterie Brunch ».
2. Remplacer le contenu par `apps-script/Code.gs`, enregistrer.
3. Choisir la fonction `testerAutorisation` → **Exécuter** → accepter les autorisations (« Paramètres avancés → Accéder au projet » si Google avertit).
4. **Paramètres du projet** (roue dentée) → **Propriétés du script** → ajouter `SECRET` = une longue phrase aléatoire.
5. **Déployer → Nouveau déploiement** → type **Application Web** : exécuter en tant que **Moi**, accès **Tout le monde** → copier l'URL qui finit par `/exec`.

### 6. Déployer la fonction d'envoi
1. Supabase → **Edge Functions → Deploy a new function → Via Editor**, nom `send-ticket`.
2. Coller `supabase/functions/send-ticket/index.ts` → **Deploy function**.
3. Dans la fonction → **Details / Settings** : désactiver **Verify JWT** (la fonction vérifie elle-même la réservation ou l'admin) → Save.
4. **Edge Functions → Secrets** : ajouter
   - `APPS_SCRIPT_URL` = l'URL `/exec`
   - `APPS_SCRIPT_SECRET` = la même phrase que `SECRET`
   - `SITE_URL` = l'adresse du site (ex. `https://brunch-bess.vercel.app`)

### 6 bis. Notifications des admins sur téléphone
1. SQL Editor : exécuter `supabase/migrations/20261001000000_push_admins.sql` (si pas déjà fait à l'étape 2).
2. **Edge Functions → Deploy a new function → Via Editor**, nom `notify-admins`, coller `supabase/functions/notify-admins/index.ts` → Deploy, puis désactiver **Verify JWT**.
3. **Edge Functions → Secrets** : ajouter `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   (valeurs dans `secrets.local.txt`, fichier local non versionné ; la clé publique est aussi dans `public/assets/config.js`).
4. Sur chaque téléphone admin : ouvrir `/admin/` → **Activer les notifications**.
   - Android (Chrome) : accepter l'autorisation. Conseillé : menu ⋮ → « Installer l'application ».
   - iPhone (iOS 16.4+) : Safari → Partager → « Sur l'écran d'accueil », ouvrir l'admin depuis l'icône, puis activer.
5. Une notification de test part à l'activation. Ensuite, chaque paiement déclaré notifie tous les téléphones admin ;
   un appui ouvre l'admin sur la réservation concernée.

### 7. Héberger le site
Vercel : **Add New → Project** → importer `bahati5/brunch-bess` → **Deploy** (`vercel.json` publie le dossier `public`).
Netlify fonctionne aussi (`netlify.toml`).

### 8. Régler la billetterie
Ouvrir `/admin/` → se connecter → **Réglages** : places, prix, numéros Airtel/Moov et nom affiché, WhatsApp de contact, lieu.
Pour tester avant le 1er octobre, avancer la date d'**ouverture**.

### Tester
1. Réserver depuis l'invitation avec un vrai e-mail.
2. Déclarer un faux paiement (ID `TEST123`).
3. Admin → **À vérifier** → **Valider** : le ticket s'affiche sur la page de suivi et l'e-mail arrive.
4. `/admin/scan.html` sur un téléphone → scanner le QR du ticket.
5. Pour repartir de zéro : `delete from audit_log; delete from sms_inbox; delete from reservations;` dans le SQL Editor.

## Numéros de téléphone (Gabon)
Depuis avril 2024 : national `0XX XX XX XX` (9 chiffres), international `+241` + 8 chiffres sans le 0.
Les comptes WhatsApp gardent le format de leur création (`+241 0XX…` ou ancien `+241 0X XX XX XX`) :
le site accepte toutes ces écritures, enregistre au format international et l'admin propose un second bouton
WhatsApp (avec / sans le 0) si le premier ne trouve pas le contact.

## À venir
- Réception automatique des SMS (Android : appli de transfert de SMS ; iPhone : automatisation Raccourcis)
  vers un webhook qui remplit `sms_inbox` puis appelle le rapprochement. Le schéma et le rapprochement sont déjà en place,
  il manque le parseur des formats Airtel / Moov.

## Tests
Le SQL a été testé sur Postgres (PGlite) : survente, blocage/expiration, ID en double, rapprochement SMS,
droits public/admin, scan. Les parcours invité, admin et scan ont été testés dans Edge headless.
