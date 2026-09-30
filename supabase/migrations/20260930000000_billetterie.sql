-- Billetterie du Grand Brunch des retrouvailles (Bessieux Alumni)
--
-- Principe : aucune table n'est lisible ni modifiable directement par le public.
-- Le site passe uniquement par des fonctions RPC (security definer) qui vérifient
-- tout côté serveur : stock, blocage des places, unicité des ID de transaction.
-- Les admins (table admins) lisent les tables via RLS et agissent via des RPC admin_*.

-- ---------------------------------------------------------------------------
-- Réglages (une seule ligne)
-- ---------------------------------------------------------------------------
create table public.settings (
  id               boolean primary key default true check (id),
  event_name       text        not null default 'Grand Brunch des retrouvailles',
  event_at         timestamptz not null default '2026-10-31 12:00:00+01',
  opening_at       timestamptz not null default '2026-10-01 00:00:00+01',
  closing_at       timestamptz not null default '2026-10-31 12:00:00+01',
  price            integer     not null default 15000 check (price > 0),
  capacity         integer     not null default 100 check (capacity >= 0),
  hold_minutes     integer     not null default 120 check (hold_minutes > 0),
  max_per_booking  integer     check (max_per_booking is null or max_per_booking > 0),
  airtel_number    text,
  airtel_name      text,
  moov_number      text,
  moov_name        text,
  contact_whatsapp text,
  -- Secret : révélé uniquement sur les tickets validés
  venue_name       text,
  venue_address    text,
  venue_maps_url   text,
  venue_notes      text,
  updated_at       timestamptz not null default now()
);
insert into public.settings default values;

-- ---------------------------------------------------------------------------
-- Admins : comptes Supabase Auth autorisés à gérer la billetterie
-- ---------------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key references auth.users on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Réservations (un ticket groupé = une réservation de N places)
-- ---------------------------------------------------------------------------
create type public.reservation_status as enum (
  'pending',    -- places bloquées, paiement attendu avant expires_at
  'declared',   -- l'invité a déclaré son paiement, à vérifier
  'validated',  -- paiement confirmé, ticket émis
  'rejected',   -- déclaration refusée (l'invité peut redéclarer)
  'expired',    -- délai de paiement dépassé, places libérées
  'cancelled',  -- annulée par un admin
  'absent'      -- réponse « je ne pourrai pas être présent(e) »
);

create table public.reservations (
  id              uuid primary key default gen_random_uuid(),
  ref             text not null unique,
  access_token    uuid not null unique default gen_random_uuid(),
  status          public.reservation_status not null default 'pending',
  last_name       text not null check (length(last_name) between 1 and 80),
  first_name      text not null check (length(first_name) between 1 and 80),
  promo           text not null check (promo in ('2018','2019','2020')),
  whatsapp        text not null check (whatsapp ~ '^\+?[0-9]{8,15}$'),
  email           text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  message         text check (message is null or length(message) <= 1000),
  quantity        integer not null check (quantity >= 0),
  unit_price      integer not null,
  amount          integer not null,
  expires_at      timestamptz,
  -- Déclaration de paiement
  operator        text check (operator in ('airtel','moov')),
  payer_phone     text,
  txn_id          text,
  declared_at     timestamptz,
  -- Décision
  validated_at    timestamptz,
  validated_by    text,            -- 'auto' ou nom de l'admin
  rejected_reason text,
  admin_note      text,
  -- Ticket
  ticket_code     text unique,
  email_sent_at   timestamptz,
  checked_in      integer not null default 0 check (checked_in >= 0 and checked_in <= quantity),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Un ID de transaction ne peut servir qu'une fois par opérateur
create unique index reservations_txn_unique
  on public.reservations (operator, upper(txn_id))
  where txn_id is not null and status in ('declared','validated');

create index reservations_status_idx on public.reservations (status);
create index reservations_whatsapp_idx on public.reservations (whatsapp);

-- ---------------------------------------------------------------------------
-- SMS reçus sur les téléphones de réception (alimentée plus tard par le webhook)
-- ---------------------------------------------------------------------------
create table public.sms_inbox (
  id             uuid primary key default gen_random_uuid(),
  received_at    timestamptz not null default now(),
  device         text,
  sender         text,
  raw            text not null,
  operator       text check (operator in ('airtel','moov')),
  amount         integer,
  txn_id         text,
  payer_phone    text,
  parsed         boolean not null default false,
  reservation_id uuid references public.reservations on delete set null,
  matched_at     timestamptz
);
create unique index sms_inbox_txn_unique on public.sms_inbox (operator, upper(txn_id)) where txn_id is not null;

-- ---------------------------------------------------------------------------
-- Journal des actions (qui a validé / refusé / scanné quoi)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  actor          text not null,
  action         text not null,
  reservation_id uuid references public.reservations on delete set null,
  details        jsonb
);

-- ---------------------------------------------------------------------------
-- RLS : rien pour le public, lecture pour les admins
-- ---------------------------------------------------------------------------
alter table public.settings     enable row level security;
alter table public.admins       enable row level security;
alter table public.reservations enable row level security;
alter table public.sms_inbox    enable row level security;
alter table public.audit_log    enable row level security;

create policy admin_read on public.settings     for select to authenticated using (public.is_admin());
create policy admin_read on public.admins       for select to authenticated using (public.is_admin());
create policy admin_read on public.reservations for select to authenticated using (public.is_admin());
create policy admin_read on public.sms_inbox    for select to authenticated using (public.is_admin());
create policy admin_read on public.audit_log    for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Utilitaires internes
-- ---------------------------------------------------------------------------
create function public._random_code(len int) returns text
language sql volatile as $$
  -- Alphabet sans caractères ambigus (0/O, 1/I/L)
  select string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + (get_byte(b, i) % 31), 1), '')
  from (select decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex') as b) s,
       generate_series(0, len - 1) as i;
$$;

create function public._normalize_phone(p text) returns text
language sql immutable as $$
  select regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g');
$$;

create function public._actor() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from admins where user_id = auth.uid()), 'système');
$$;

-- Passe en « expired » les réservations dont le délai est dépassé
create function public._expire_holds() returns void
language sql security definer set search_path = public as $$
  update reservations set status = 'expired', updated_at = now()
  where status = 'pending' and expires_at < now();
$$;

-- Places occupées : validées + déclarées + bloquées encore valides
create function public._seats_taken(exclude_id uuid default null) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(quantity), 0)::int from reservations
  where (exclude_id is null or id <> exclude_id)
    and (status in ('validated','declared') or (status = 'pending' and expires_at > now()));
$$;

-- Valide une réservation et émet son ticket
create function public._validate(r_id uuid, by_whom text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update reservations
     set status = 'validated', validated_at = now(), validated_by = by_whom,
         rejected_reason = null,
         ticket_code = coalesce(ticket_code, _random_code(10)),
         updated_at = now()
   where id = r_id;
  insert into audit_log (actor, action, reservation_id) values (by_whom, 'validate', r_id);
end $$;

-- Rapproche une réservation déclarée d'un SMS reçu (même opérateur, même ID, même montant)
create function public._try_match(r_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare r reservations; s sms_inbox;
begin
  select * into r from reservations where id = r_id and status = 'declared' for update;
  if not found then return false; end if;
  select * into s from sms_inbox
   where operator = r.operator and upper(txn_id) = upper(r.txn_id)
     and amount = r.amount and reservation_id is null
   for update limit 1;
  if not found then return false; end if;
  update sms_inbox set reservation_id = r.id, matched_at = now() where id = s.id;
  perform _validate(r.id, 'auto');
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- RPC publiques
-- ---------------------------------------------------------------------------

-- Infos affichées sur l'invitation et la page de paiement (sans le lieu)
create function public.get_public_info() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s settings;
begin
  perform _expire_holds();
  select * into s from settings;
  return jsonb_build_object(
    'event_name', s.event_name, 'event_at', s.event_at,
    'opening_at', s.opening_at, 'closing_at', s.closing_at,
    'price', s.price, 'hold_minutes', s.hold_minutes, 'max_per_booking', s.max_per_booking,
    'remaining', greatest(s.capacity - _seats_taken(), 0),
    'airtel_number', s.airtel_number, 'airtel_name', s.airtel_name,
    'moov_number', s.moov_number, 'moov_name', s.moov_name,
    'contact_whatsapp', s.contact_whatsapp
  );
end $$;

-- Crée une réservation et bloque les places
create function public.create_reservation(
  p_last_name text, p_first_name text, p_promo text, p_whatsapp text,
  p_email text, p_quantity int, p_message text, p_attending boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s settings; v_phone text; v_ref text; r reservations; v_left int;
begin
  -- Verrou sur la ligne de réglages : sérialise les réservations pour ne jamais survendre
  select * into s from settings for update;
  perform _expire_holds();

  v_phone := _normalize_phone(p_whatsapp);
  if nullif(trim(p_email), '') is null and p_attending then
    raise exception 'EMAIL_REQUIRED' using hint = 'Indique ton e-mail pour recevoir ton ticket.';
  end if;

  if p_attending then
    if now() < s.opening_at then
      raise exception 'NOT_OPEN' using hint = 'La billetterie n''est pas encore ouverte.';
    end if;
    if now() >= s.closing_at then
      raise exception 'CLOSED' using hint = 'La billetterie est fermée.';
    end if;
    if p_quantity is null or p_quantity < 1 then
      raise exception 'BAD_QUANTITY' using hint = 'Choisis au moins un ticket.';
    end if;
    if s.max_per_booking is not null and p_quantity > s.max_per_booking then
      raise exception 'TOO_MANY' using hint = format('Maximum %s tickets par réservation.', s.max_per_booking);
    end if;

    -- Une seule réservation en attente par numéro : l'ancienne est annulée
    update reservations set status = 'cancelled', admin_note = 'Remplacée par une nouvelle réservation', updated_at = now()
     where whatsapp = v_phone and status = 'pending';

    v_left := s.capacity - _seats_taken();
    if p_quantity > v_left then
      raise exception 'SOLD_OUT' using hint = case when v_left <= 0
        then 'Il n''y a plus de places disponibles.'
        else format('Il ne reste que %s place(s).', v_left) end;
    end if;
  end if;

  loop
    v_ref := 'BB-' || _random_code(5);
    exit when not exists (select 1 from reservations where ref = v_ref);
  end loop;

  insert into reservations (ref, status, last_name, first_name, promo, whatsapp, email, message,
                            quantity, unit_price, amount, expires_at)
  values (v_ref, case when p_attending then 'pending' else 'absent' end::reservation_status,
          trim(p_last_name), trim(p_first_name), p_promo, v_phone,
          nullif(lower(trim(p_email)), ''), nullif(trim(p_message), ''),
          case when p_attending then p_quantity else 0 end, s.price,
          case when p_attending then p_quantity * s.price else 0 end,
          case when p_attending then now() + make_interval(mins => s.hold_minutes) end)
  returning * into r;

  return jsonb_build_object('ref', r.ref, 'token', r.access_token, 'status', r.status);
end $$;

-- Détail d'une réservation pour son titulaire (ref + token secret)
create function public.get_reservation(p_ref text, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations; s settings; v_left int;
begin
  perform _expire_holds();
  select * into r from reservations where ref = upper(trim(p_ref)) and access_token = p_token;
  if not found then return null; end if;
  select * into s from settings;
  v_left := greatest(s.capacity - _seats_taken(r.id), 0);
  return jsonb_build_object(
    'ref', r.ref, 'status', r.status,
    'last_name', r.last_name, 'first_name', r.first_name, 'promo', r.promo,
    'whatsapp', r.whatsapp, 'email', r.email,
    'quantity', r.quantity, 'amount', r.amount, 'expires_at', r.expires_at,
    'operator', r.operator, 'payer_phone', r.payer_phone, 'txn_id', r.txn_id, 'declared_at', r.declared_at,
    'rejected_reason', r.rejected_reason, 'validated_at', r.validated_at,
    'can_redeclare', r.status in ('expired','rejected') and r.quantity <= v_left and now() < s.closing_at,
    'email_sent', r.email_sent_at is not null,
    'ticket_code', case when r.status = 'validated' then r.ticket_code end,
    'checked_in', r.checked_in,
    'venue', case when r.status = 'validated' then jsonb_build_object(
      'name', s.venue_name, 'address', s.venue_address, 'maps_url', s.venue_maps_url, 'notes', s.venue_notes) end
  );
end $$;

-- Retrouver sa réservation avec sa référence et son numéro WhatsApp
create function public.find_reservation(p_ref text, p_whatsapp text) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('ref', ref, 'token', access_token)
  from reservations
  where ref = upper(trim(p_ref)) and whatsapp = _normalize_phone(p_whatsapp) and status <> 'absent';
$$;

-- L'invité déclare son paiement mobile money
create function public.declare_payment(
  p_ref text, p_token uuid, p_operator text, p_payer_phone text, p_txn_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations; s settings; v_txn text; v_matched boolean;
begin
  select * into s from settings for update;
  perform _expire_holds();
  select * into r from reservations where ref = upper(trim(p_ref)) and access_token = p_token for update;
  if not found then raise exception 'NOT_FOUND' using hint = 'Réservation introuvable.'; end if;

  if p_operator not in ('airtel','moov') then
    raise exception 'BAD_OPERATOR' using hint = 'Choisis Airtel Money ou Moov Money.';
  end if;
  v_txn := upper(regexp_replace(coalesce(p_txn_id, ''), '\s', '', 'g'));
  if length(v_txn) < 4 then
    raise exception 'BAD_TXN' using hint = 'Indique l''ID de transaction reçu par SMS.';
  end if;
  if _normalize_phone(p_payer_phone) !~ '^\+?[0-9]{8,15}$' then
    raise exception 'BAD_PHONE' using hint = 'Indique le numéro qui a envoyé le paiement.';
  end if;

  if r.status in ('validated','cancelled','absent') then
    raise exception 'BAD_STATUS' using hint = 'Cette réservation ne peut plus être modifiée.';
  end if;
  -- Délai dépassé ou refus : on redéclare seulement s'il reste assez de places
  if r.status in ('expired','rejected') and r.quantity > s.capacity - _seats_taken(r.id) then
    raise exception 'SOLD_OUT' using hint = 'Il n''y a plus assez de places. Contacte l''organisation si tu as déjà payé.';
  end if;

  if exists (select 1 from reservations
              where id <> r.id and operator = p_operator and upper(txn_id) = v_txn
                and status in ('declared','validated')) then
    raise exception 'TXN_USED' using hint = 'Cet ID de transaction a déjà été utilisé.';
  end if;

  update reservations
     set status = 'declared', operator = p_operator, payer_phone = _normalize_phone(p_payer_phone),
         txn_id = v_txn, declared_at = now(), rejected_reason = null, updated_at = now()
   where id = r.id;
  insert into audit_log (actor, action, reservation_id, details)
  values ('invité', 'declare', r.id, jsonb_build_object('operator', p_operator, 'txn_id', v_txn));

  v_matched := _try_match(r.id);
  return jsonb_build_object('status', case when v_matched then 'validated' else 'declared' end);
end $$;

-- ---------------------------------------------------------------------------
-- RPC admin
-- ---------------------------------------------------------------------------
create function public._require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'FORBIDDEN' using hint = 'Accès réservé aux admins.'; end if;
end $$;

create function public.admin_validate(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r reservations;
begin
  perform _require_admin();
  select * into r from reservations where id = p_id for update;
  if not found or r.status in ('validated','absent','cancelled') then
    raise exception 'BAD_STATUS' using hint = 'Cette réservation ne peut pas être validée.';
  end if;
  if p_note is not null then update reservations set admin_note = p_note where id = p_id; end if;
  perform _validate(p_id, _actor());
end $$;

create function public.admin_reject(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  update reservations set status = 'rejected', rejected_reason = nullif(trim(p_reason), ''), updated_at = now()
   where id = p_id and status in ('declared','pending');
  if not found then raise exception 'BAD_STATUS' using hint = 'Cette réservation ne peut pas être refusée.'; end if;
  insert into audit_log (actor, action, reservation_id, details) values (_actor(), 'reject', p_id, jsonb_build_object('reason', p_reason));
end $$;

create function public.admin_cancel(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  update reservations set status = 'cancelled', admin_note = nullif(trim(p_reason), ''), updated_at = now()
   where id = p_id and status <> 'cancelled';
  insert into audit_log (actor, action, reservation_id, details) values (_actor(), 'cancel', p_id, jsonb_build_object('reason', p_reason));
end $$;

-- Réservation saisie par un admin (paiement en espèces, invité sans smartphone…), validée d'office
create function public.admin_create_reservation(
  p_last_name text, p_first_name text, p_promo text, p_whatsapp text,
  p_email text, p_quantity int, p_note text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s settings; v_ref text; r reservations;
begin
  perform _require_admin();
  select * into s from settings for update;
  loop
    v_ref := 'BB-' || _random_code(5);
    exit when not exists (select 1 from reservations where ref = v_ref);
  end loop;
  insert into reservations (ref, status, last_name, first_name, promo, whatsapp, email, quantity, unit_price, amount, admin_note)
  values (v_ref, 'declared', trim(p_last_name), trim(p_first_name), p_promo, _normalize_phone(p_whatsapp),
          nullif(lower(trim(p_email)), ''), p_quantity, s.price, p_quantity * s.price, nullif(trim(p_note), ''))
  returning * into r;
  perform _validate(r.id, _actor());
  return jsonb_build_object('id', r.id, 'ref', r.ref, 'token', r.access_token);
end $$;

-- Contrôle à l'entrée : p_admit = 0 pour consulter, > 0 pour faire entrer N personnes
create function public.admin_check_in(p_code text, p_admit int default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations;
begin
  perform _require_admin();
  select * into r from reservations where ticket_code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('found', false); end if;
  if p_admit > 0 then
    if r.status <> 'validated' then raise exception 'BAD_STATUS' using hint = 'Ticket non valide.'; end if;
    if r.checked_in + p_admit > r.quantity then
      raise exception 'TOO_MANY' using hint = format('Il ne reste que %s entrée(s) sur ce ticket.', r.quantity - r.checked_in);
    end if;
    update reservations set checked_in = checked_in + p_admit, updated_at = now() where id = r.id returning * into r;
    insert into audit_log (actor, action, reservation_id, details) values (_actor(), 'check_in', r.id, jsonb_build_object('admit', p_admit));
  end if;
  return jsonb_build_object('found', true, 'ref', r.ref, 'status', r.status,
    'name', r.first_name || ' ' || r.last_name, 'promo', r.promo,
    'quantity', r.quantity, 'checked_in', r.checked_in);
end $$;

create function public.admin_update_settings(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  update settings set
    event_at         = coalesce((p->>'event_at')::timestamptz, event_at),
    opening_at       = coalesce((p->>'opening_at')::timestamptz, opening_at),
    closing_at       = coalesce((p->>'closing_at')::timestamptz, closing_at),
    price            = coalesce((p->>'price')::int, price),
    capacity         = coalesce((p->>'capacity')::int, capacity),
    hold_minutes     = coalesce((p->>'hold_minutes')::int, hold_minutes),
    max_per_booking  = case when p ? 'max_per_booking' then nullif(p->>'max_per_booking', '')::int else max_per_booking end,
    airtel_number    = case when p ? 'airtel_number'    then nullif(p->>'airtel_number', '')    else airtel_number end,
    airtel_name      = case when p ? 'airtel_name'      then nullif(p->>'airtel_name', '')      else airtel_name end,
    moov_number      = case when p ? 'moov_number'      then nullif(p->>'moov_number', '')      else moov_number end,
    moov_name        = case when p ? 'moov_name'        then nullif(p->>'moov_name', '')        else moov_name end,
    contact_whatsapp = case when p ? 'contact_whatsapp' then nullif(p->>'contact_whatsapp', '') else contact_whatsapp end,
    venue_name       = case when p ? 'venue_name'       then nullif(p->>'venue_name', '')       else venue_name end,
    venue_address    = case when p ? 'venue_address'    then nullif(p->>'venue_address', '')    else venue_address end,
    venue_maps_url   = case when p ? 'venue_maps_url'   then nullif(p->>'venue_maps_url', '')   else venue_maps_url end,
    venue_notes      = case when p ? 'venue_notes'      then nullif(p->>'venue_notes', '')      else venue_notes end,
    updated_at       = now();
  insert into audit_log (actor, action, details) values (_actor(), 'settings', p);
end $$;

-- ---------------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.get_public_info()                                           to anon, authenticated;
grant execute on function public.create_reservation(text,text,text,text,text,int,text,boolean) to anon, authenticated;
grant execute on function public.get_reservation(text,uuid)                                  to anon, authenticated;
grant execute on function public.find_reservation(text,text)                                 to anon, authenticated;
grant execute on function public.declare_payment(text,uuid,text,text,text)                   to anon, authenticated;

grant execute on function public.is_admin()                                                  to authenticated;
grant execute on function public.admin_validate(uuid,text)                                   to authenticated;
grant execute on function public.admin_reject(uuid,text)                                     to authenticated;
grant execute on function public.admin_cancel(uuid,text)                                     to authenticated;
grant execute on function public.admin_create_reservation(text,text,text,text,text,int,text) to authenticated;
grant execute on function public.admin_check_in(text,int)                                    to authenticated;
grant execute on function public.admin_update_settings(jsonb)                                to authenticated;

-- Les nouvelles fonctions ne sont pas exécutables par défaut
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
