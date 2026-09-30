-- Correctif : Supabase refuse les UPDATE sans WHERE venant de l'API (pg-safeupdate).
-- La mise à jour des réglages échouait avec une erreur 400. À exécuter une fois dans le SQL Editor.
create or replace function public.admin_update_settings(p jsonb) returns void
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
    updated_at       = now()
  where id;
  insert into audit_log (actor, action, details) values (_actor(), 'settings', p);
end $$;
