-- Déclaration de paiement par capture d'écran (plus d'ID de transaction à recopier)
-- et e-mail facultatif. À exécuter une fois dans le SQL Editor, après les migrations précédentes.

-- Nom et prénom saisis dans un seul champ : le « nom » peut rester vide
alter table public.reservations drop constraint if exists reservations_last_name_check;
alter table public.reservations add constraint reservations_last_name_check check (length(last_name) <= 80);

-- Capture d'écran du paiement (fichier privé dans le bucket « proofs ») et son empreinte (détection des doublons)
alter table public.reservations add column proof_path text;
alter table public.reservations add column proof_hash text;
create index reservations_proof_hash_idx on public.reservations (proof_hash);

-- Bucket privé : seuls les admins peuvent lire les captures ; l'envoi passe par l'Edge Function « upload-proof »
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 6291456, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy "admins lisent les captures" on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and public.is_admin());

-- E-mail facultatif : le ticket part par WhatsApp, et aussi par e-mail s'il est donné
create or replace function public.create_reservation(
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
          coalesce(trim(p_last_name), ''), trim(p_first_name), p_promo, v_phone,
          nullif(lower(trim(p_email)), ''), nullif(trim(p_message), ''),
          case when p_attending then p_quantity else 0 end, s.price,
          case when p_attending then p_quantity * s.price else 0 end,
          case when p_attending then now() + make_interval(mins => s.hold_minutes) end)
  returning * into r;

  return jsonb_build_object('ref', r.ref, 'token', r.access_token, 'status', r.status);
end $$;

-- Passe une réservation en « à vérifier », avec ou sans capture
create function public._declare(p_ref text, p_token uuid, p_path text, p_hash text) returns jsonb
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
  if r.status in ('expired','rejected') and r.quantity > s.capacity - _seats_taken(r.id) then
    raise exception 'SOLD_OUT' using hint = 'Il n''y a plus assez de places. Contacte l''organisation si tu as déjà payé.';
  end if;

  update reservations
     set status = 'declared', declared_at = now(), rejected_reason = null, notified_at = null,
         proof_path = coalesce(p_path, proof_path), proof_hash = coalesce(p_hash, proof_hash), updated_at = now()
   where id = r.id;
  v_dup := p_hash is not null and exists (select 1 from reservations where proof_hash = p_hash and id <> r.id);
  insert into audit_log (actor, action, reservation_id, details)
  values ('invité', 'declare', r.id, jsonb_build_object('capture', p_path is not null, 'doublon', v_dup));
  return jsonb_build_object('status', 'declared', 'duplicate', v_dup);
end $$;

-- Invité : « j'ai payé » sans capture
create function public.declare_proof(p_ref text, p_token uuid) returns jsonb
language sql security definer set search_path = public as $$
  select _declare(p_ref, p_token, null, null);
$$;

-- Edge Function (clé service) : « j'ai payé » avec la capture déjà enregistrée
create function public.attach_proof(p_ref text, p_token uuid, p_path text, p_hash text) returns jsonb
language sql security definer set search_path = public as $$
  select _declare(p_ref, p_token, p_path, p_hash);
$$;

revoke execute on function public._declare(text,uuid,text,text) from public, anon, authenticated;
revoke execute on function public.declare_proof(text,uuid) from public;
revoke execute on function public.attach_proof(text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.declare_proof(text,uuid) to anon, authenticated;
grant execute on function public.attach_proof(text,uuid,text,text) to service_role;

-- La page de suivi montre à l'invité si sa capture est bien arrivée
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
    'rejected_reason', r.rejected_reason, 'validated_at', r.validated_at,
    'can_redeclare', r.status in ('expired','rejected') and r.quantity <= v_left and now() < s.closing_at,
    'email_sent', r.email_sent_at is not null,
    'ticket_code', case when r.status = 'validated' then r.ticket_code end,
    'checked_in', r.checked_in,
    'venue', case when r.status = 'validated' then jsonb_build_object(
      'name', s.venue_name, 'address', s.venue_address, 'maps_url', s.venue_maps_url, 'notes', s.venue_notes) end
  );
end $$;

-- Retrouver sa réservation : même numéro avec ou sans indicatif, avec ou sans le 0 (074… = +241 74… = +241 074…)
create or replace function public._phone_key(p text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '^241', ''), '^0', '');
$$;
revoke execute on function public._phone_key(text) from public, anon, authenticated;

create or replace function public.find_reservation(p_ref text, p_whatsapp text) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('ref', ref, 'token', access_token)
  from reservations
  where ref = upper(trim(p_ref)) and _phone_key(whatsapp) = _phone_key(p_whatsapp) and status <> 'absent';
$$;
