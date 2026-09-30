-- Notifications push des admins (appli admin installée sur le téléphone).
-- À exécuter une fois dans le SQL Editor, après les migrations précédentes.

-- Abonnements push : un par appareil admin
create table public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid not null references auth.users on delete cascade,
  subscription jsonb not null,
  device       text,
  created_at   timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy admin_read on public.push_subscriptions for select to authenticated using (public.is_admin());

-- Date de la dernière notification envoyée pour une déclaration (évite les doublons)
alter table public.reservations add column notified_at timestamptz;

create function public.admin_save_push(p_sub jsonb, p_device text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  if coalesce(p_sub->>'endpoint', '') = '' then raise exception 'BAD_SUB' using hint = 'Abonnement invalide.'; end if;
  insert into push_subscriptions (endpoint, user_id, subscription, device)
  values (p_sub->>'endpoint', auth.uid(), p_sub, left(p_device, 200))
  on conflict (endpoint) do update set user_id = excluded.user_id, subscription = excluded.subscription, device = excluded.device;
end $$;

create function public.admin_delete_push(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;

-- Une correction de déclaration relance la notification
create or replace function public.declare_payment(
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
         txn_id = v_txn, declared_at = now(), rejected_reason = null, notified_at = null, updated_at = now()
   where id = r.id;
  insert into audit_log (actor, action, reservation_id, details)
  values ('invité', 'declare', r.id, jsonb_build_object('operator', p_operator, 'txn_id', v_txn));

  v_matched := _try_match(r.id);
  return jsonb_build_object('status', case when v_matched then 'validated' else 'declared' end);
end $$;

revoke execute on function public.admin_save_push(jsonb,text) from public, anon;
revoke execute on function public.admin_delete_push(text) from public, anon;
grant execute on function public.admin_save_push(jsonb,text) to authenticated;
grant execute on function public.admin_delete_push(text) to authenticated;

-- Retrouver sa réservation : comparaison sur les chiffres seuls (avec ou sans « + »)
create or replace function public.find_reservation(p_ref text, p_whatsapp text) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('ref', ref, 'token', access_token)
  from reservations
  where ref = upper(trim(p_ref))
    and regexp_replace(whatsapp, '\D', '', 'g') = regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g')
    and status <> 'absent';
$$;
