-- Additive migration for e-Leão. Does not alter Supabase Auth or any other app's tables.
-- Já aplicada no projeto Supabase `conversor` (byqhiewzkbqvvmldnwky) com a versão
-- 20261118111202. Este arquivo existe para que a integração Supabase + GitHub
-- encontre a versão remota no diretório local; não recria nem altera nada.
create table public.eleao_profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null check(length(display_name) between 1 and 80),
 role text not null default 'member' check(role in ('admin','member')),
 active boolean not null default true, created_at timestamptz not null default now()
);
create table public.eleao_operations (
 id uuid primary key default gen_random_uuid(),owner_id uuid not null default auth.uid() references public.eleao_profiles(id) on delete cascade,
 kind text not null check(kind in ('simulation','invoice')),title text not null check(length(trim(title)) between 1 and 140),
 on_date date not null,regime text not null check(regime in ('Regime regular','Simples Nacional')),
 base_cents bigint not null check(base_cents between 1 and 99999999900),cbs_cents bigint not null default 0 check(cbs_cents between 0 and 99999999900),
 ibs_cents bigint not null default 0 check(ibs_cents between 0 and 99999999900),is_cents bigint not null default 0 check(is_cents between 0 and 99999999900),
 details jsonb not null default '{}',created_at timestamptz not null default now(),
 check(jsonb_typeof(details)='object' and octet_length(details::text)<=24000), check(kind='simulation' or (cbs_cents=0 and ibs_cents=0 and is_cents=0))
);
create index eleao_period on public.eleao_operations(owner_id,on_date desc,id);
create table public.eleao_articles (id text primary key default gen_random_uuid()::text,category text not null check(length(category) between 1 and 50), question text not null check(length(question) between 5 and 200),answer text not null check(length(answer) between 10 and 4000),source text not null check(source like 'https://%' and length(source)<=1000),keywords text not null default '' check(length(keywords)<=500));
create table public.eleao_feedback (id uuid primary key default gen_random_uuid(),owner_id uuid not null default auth.uid() references public.eleao_profiles(id) on delete cascade, article_id text not null references public.eleao_articles(id) on delete cascade, helpful boolean not null, unique(owner_id,article_id));
create table public.eleao_usage (owner_id uuid not null references public.eleao_profiles(id) on delete cascade,day date not null default current_date,uses integer not null,primary key(owner_id,day));
alter table public.eleao_profiles enable row level security;
alter table public.eleao_operations enable row level security;
alter table public.eleao_articles enable row level security;
alter table public.eleao_feedback enable row level security;
alter table public.eleao_usage enable row level security;
revoke all on public.eleao_profiles,public.eleao_operations,public.eleao_articles,public.eleao_feedback,public.eleao_usage from public,anon,authenticated;
grant select on public.eleao_profiles,public.eleao_operations,public.eleao_articles,public.eleao_feedback to authenticated;
grant update(display_name) on public.eleao_profiles to authenticated;
grant insert(id,kind,title,on_date,regime,base_cents,cbs_cents,ibs_cents,is_cents,details),update(title,on_date,regime,base_cents,cbs_cents,ibs_cents,is_cents,details),delete on public.eleao_operations to authenticated;
grant insert,update,delete on public.eleao_articles to authenticated;
grant insert(article_id,helpful),update(helpful,article_id) on public.eleao_feedback to authenticated;
create function public.eleao_is_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.eleao_profiles where id=auth.uid() and active and role='admin')$$;
create function public.eleao_is_active() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.eleao_profiles where id=auth.uid() and active)$$;
-- Membership is opt-in. No trigger touches accounts belonging only to other applications.
create function public.eleao_join() returns void language plpgsql security definer set search_path='' as $$
begin
 insert into public.eleao_profiles(id,display_name) select u.id,left(coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'),''),'Contribuinte'),80) from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null on conflict(id) do nothing;
 if not exists(select 1 from public.eleao_profiles where id=auth.uid()) then raise exception 'Confirme seu e-mail para continuar.'; end if;
end;$$;
create policy eleao_profile_read on public.eleao_profiles for select to authenticated using(id=auth.uid() or public.eleao_is_admin());
create policy eleao_profile_name on public.eleao_profiles for update to authenticated using(id=auth.uid() and active) with check(id=auth.uid() and active);
create policy eleao_ops_read on public.eleao_operations for select to authenticated using((owner_id=auth.uid() and public.eleao_is_active()) or public.eleao_is_admin());
create policy eleao_ops_create on public.eleao_operations for insert to authenticated with check(owner_id=auth.uid() and public.eleao_is_active());
create policy eleao_ops_edit on public.eleao_operations for update to authenticated using((owner_id=auth.uid() and public.eleao_is_active()) or public.eleao_is_admin()) with check((owner_id=auth.uid() and public.eleao_is_active()) or public.eleao_is_admin());
create policy eleao_ops_delete on public.eleao_operations for delete to authenticated using((owner_id=auth.uid() and public.eleao_is_active()) or public.eleao_is_admin());
create policy eleao_knowledge_read on public.eleao_articles for select to authenticated using(public.eleao_is_active());
create policy eleao_knowledge_write on public.eleao_articles for all to authenticated using(public.eleao_is_admin()) with check(public.eleao_is_admin());
create policy eleao_feedback_read on public.eleao_feedback for select to authenticated using((owner_id=auth.uid() and public.eleao_is_active()) or public.eleao_is_admin());
create policy eleao_feedback_insert on public.eleao_feedback for insert to authenticated with check(owner_id=auth.uid() and public.eleao_is_active());
create policy eleao_feedback_update on public.eleao_feedback for update to authenticated using(owner_id=auth.uid() and public.eleao_is_active()) with check(owner_id=auth.uid() and public.eleao_is_active());
create function public.eleao_set_active(member_id uuid,enabled boolean) returns void language plpgsql security definer set search_path='' as $$
begin if not public.eleao_is_admin() then raise exception 'Acesso restrito' using errcode='42501'; end if; update public.eleao_profiles set active=enabled where id=member_id and role='member'; if not found then raise exception 'Conta não alterada'; end if; end;$$;
create function public.eleao_take_quota() returns boolean language plpgsql security definer set search_path='' as $$
begin if not public.eleao_is_active() then return false; end if; insert into public.eleao_usage(owner_id,uses) values(auth.uid(),1) on conflict(owner_id,day) do update set uses=eleao_usage.uses+1 where eleao_usage.uses<40; return found; end;$$;
revoke all on function public.eleao_join(),public.eleao_is_admin(),public.eleao_is_active(),public.eleao_set_active(uuid,boolean),public.eleao_take_quota() from public,anon,authenticated;
grant execute on function public.eleao_join(),public.eleao_is_admin(),public.eleao_is_active(),public.eleao_set_active(uuid,boolean),public.eleao_take_quota() to authenticated;
