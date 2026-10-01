-- Réouverture d'une réservation (paiement à compléter), historique des captures et liste d'attente.
-- À exécuter une fois dans le SQL Editor, après les migrations précédentes.

-- ---------------------------------------------------------------------------
-- Historique des captures : on garde toutes les captures envoyées (ex. paiement + complément)
-- ---------------------------------------------------------------------------
alter table public.reservations add column proof_history text[] not null default '{}';
update public.reservations set proof_history = array[proof_path] where proof_path is not null;

-- Réservation rouverte par un admin : l'invité peut renvoyer une capture même si c'est complet
alter table public.reservations add column reopened_at timestamptz;

create or replace function public._declare(p_ref text, p_token uuid, p_path text, p_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations; s settings; v_dup boolean;
begin
  select * into s from settings for update;
  perform _expire_holds();
  select * into r from reservations where ref = upper(trim(p_ref)) and access_token = p_token for update;
  if not found then raise exception 'NOT_FOUND' using hint = 'Réservation introuvable.'; end if;
  if r.status in ('validated','cancelled','absent') then
    raise exception 'BAD_STATUS' using hint = 'Cette réservation ne peut plus être modifiée.';
  end if;
  if r.status in ('expired','rejected') and r.reopened_at is null and r.quantity > s.capacity - _seats_taken(r.id) then
    raise exception 'SOLD_OUT' using hint = 'Il n''y a plus assez de places. Contacte l''organisation si tu as déjà payé.';
  end if;

  update reservations
     set status = 'declared', declared_at = now(), rejected_reason = null, notified_at = null,
         proof_path = coalesce(p_path, proof_path), proof_hash = coalesce(p_hash, proof_hash),
         proof_history = case when p_path is null then proof_history else proof_history || p_path end,
         updated_at = now()
   where id = r.id;
  v_dup := p_hash is not null and exists (select 1 from reservations where proof_hash = p_hash and id <> r.id);
  insert into audit_log (actor, action, reservation_id, details)
  values ('invité', 'declare', r.id, jsonb_build_object('capture', p_path is not null, 'doublon', v_dup));
  return jsonb_build_object('status', 'declared', 'duplicate', v_dup);
end $$;

-- Un admin rouvre une réservation annulée, refusée ou expirée, avec un message pour l'invité
create function public.admin_reopen(p_id uuid, p_message text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  update reservations
     set status = 'rejected', rejected_reason = nullif(trim(p_message), ''), reopened_at = now(), updated_at = now()
   where id = p_id and status in ('cancelled', 'rejected', 'expired');
  if not found then raise exception 'BAD_STATUS' using hint = 'Cette réservation ne peut pas être rouverte.'; end if;
  insert into audit_log (actor, action, reservation_id, details) values (_actor(), 'reopen', p_id, jsonb_build_object('message', p_message));
end $$;

-- La page de suivi sait si la réservation a été rouverte
create or replace function public.get_reservation(p_ref text, p_token uuid) returns jsonb
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
    'has_proof', r.proof_path is not null,
    'reopened', r.reopened_at is not null,
    'rejected_reason', r.rejected_reason, 'validated_at', r.validated_at,
    'can_redeclare', r.status in ('expired','rejected') and now() < s.closing_at and (r.reopened_at is not null or r.quantity <= v_left),
    'email_sent', r.email_sent_at is not null,
    'ticket_code', case when r.status = 'validated' then r.ticket_code end,
    'checked_in', r.checked_in,
    'venue', case when r.status = 'validated' then jsonb_build_object(
      'name', s.venue_name, 'address', s.venue_address, 'maps_url', s.venue_maps_url, 'notes', s.venue_notes) end
  );
end $$;

-- ---------------------------------------------------------------------------
-- Liste d'attente (quand toutes les places sont prises)
-- ---------------------------------------------------------------------------
create table public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null check (length(name) between 1 and 120),
  whatsapp    text not null check (whatsapp ~ '^\+?[0-9]{8,15}$'),
  promo       text not null check (promo in ('2018','2019','2020')),
  quantity    integer not null check (quantity between 1 and 20),
  status      text not null default 'waiting' check (status in ('waiting','notified','removed')),
  notified_at timestamptz
);
create unique index waitlist_whatsapp_unique on public.waitlist (whatsapp) where status <> 'removed';
alter table public.waitlist enable row level security;
create policy admin_read on public.waitlist for select to authenticated using (public.is_admin());

create function public.join_waitlist(p_name text, p_whatsapp text, p_promo text, p_quantity int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_phone text := _normalize_phone(p_whatsapp); v_pos int;
begin
  if nullif(trim(p_name), '') is null then raise exception 'BAD_NAME' using hint = 'Indique ton nom et ton prénom.'; end if;
  if v_phone !~ '^\+?[0-9]{8,15}$' then raise exception 'BAD_PHONE' using hint = 'Indique un numéro WhatsApp valide.'; end if;
  if p_promo not in ('2018','2019','2020') then raise exception 'BAD_PROMO' using hint = 'Choisis ta promotion.'; end if;
  -- Déjà inscrit : on met à jour sa demande
  update waitlist set name = trim(p_name), promo = p_promo, quantity = greatest(1, least(p_quantity, 20))
   where whatsapp = v_phone and status <> 'removed';
  if not found then
    insert into waitlist (name, whatsapp, promo, quantity) values (trim(p_name), v_phone, p_promo, greatest(1, least(p_quantity, 20)));
  end if;
  select count(*) into v_pos from waitlist where status = 'waiting'
    and created_at <= (select created_at from waitlist where whatsapp = v_phone and status <> 'removed');
  return jsonb_build_object('position', v_pos);
end $$;

create function public.admin_waitlist_set(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  if p_status not in ('waiting','notified','removed') then raise exception 'BAD_STATUS'; end if;
  update waitlist set status = p_status, notified_at = case when p_status = 'notified' then now() else notified_at end where id = p_id;
end $$;

-- Droits
revoke execute on function public.admin_reopen(uuid,text) from public, anon;
revoke execute on function public.admin_waitlist_set(uuid,text) from public, anon;
revoke execute on function public.join_waitlist(text,text,text,int) from public;
grant execute on function public.admin_reopen(uuid,text) to authenticated;
grant execute on function public.admin_waitlist_set(uuid,text) to authenticated;
grant execute on function public.join_waitlist(text,text,text,int) to anon, authenticated;
