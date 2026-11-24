-- Bootstrap only the explicitly authorized, email-verified product owner.
-- This is opt-in via the authenticated caller's own session; it creates no global Auth trigger.
create function public.eleao_claim_owner() returns boolean
language plpgsql security definer set search_path=''
as $$
declare
  caller_id uuid := auth.uid();
  verified_email text;
  owner_name text;
begin
  if caller_id is null then
    raise exception 'Entre na sua conta antes de provisionar o perfil do proprietário.' using errcode='42501';
  end if;

  select lower(u.email), left(coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Administrador'), 80)
    into verified_email, owner_name
    from auth.users u
   where u.id = caller_id and u.email_confirmed_at is not null;

  -- A verified address is looked up from auth.users, never trusted from user metadata or request input.
  if verified_email is distinct from 'ademirvarjao@gmail.com' then
    return false;
  end if;

  insert into public.eleao_profiles(id, display_name, role, active)
  values (caller_id, owner_name, 'admin', true)
  on conflict (id) do update
    set role = 'admin', active = true;

  return true;
end;
$$;
revoke all on function public.eleao_claim_owner() from public, anon, authenticated;
grant execute on function public.eleao_claim_owner() to authenticated;
