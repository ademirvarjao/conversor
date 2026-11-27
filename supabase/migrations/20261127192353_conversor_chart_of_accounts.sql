-- ============================================================================
--  Conversor — Plano de Contas Questor e aprendizado da IA no Conciliador
-- ============================================================================
--  Armazena o Plano de Contas importado do Questor ("Plano de Contas Específico
--  sem Saldo"), controla atualizações incrementais (novas contas, alterações e
--  desativações) e persiste o que a IA aprende nas conciliações e preenchimentos
--  manuais.
-- ============================================================================

create table if not exists public.conversor_chart_plans (
  id                      text primary key,
  company_code            text not null default '',
  company_name            text not null,
  cnpj                    text not null default '',
  source_file             text not null default '',
  total_accounts          integer not null default 0,
  analytic_accounts       integer not null default 0,
  excluded_counterparties integer not null default 0,
  version                 integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.conversor_chart_plans is
  'Planos de Contas do Questor salvos no banco compartilhado (metadados por empresa).';

create table if not exists public.conversor_chart_accounts (
  plan_id         text not null references public.conversor_chart_plans(id) on delete cascade,
  conta           text not null,
  classification  text not null,
  name            text not null,
  alias           text not null default '',
  group_path      text not null default '',
  is_synthetic    boolean not null default false,
  is_counterparty boolean not null default false,
  nature          text not null default '',
  active          boolean not null default true,
  updated_at      timestamptz not null default now(),
  primary key (plan_id, conta)
);

comment on table public.conversor_chart_accounts is
  'Contas contábeis do Plano de Contas Questor (a coluna conta preenche débito/crédito no Conciliador).';

create index if not exists conversor_chart_accounts_plan_active_idx
  on public.conversor_chart_accounts (plan_id, active, is_synthetic, is_counterparty);

create table if not exists public.conversor_chart_ai_rules (
  id             bigserial primary key,
  plan_id        text not null references public.conversor_chart_plans(id) on delete cascade,
  history_key    text not null,
  direction      text not null check (direction in ('payment', 'receipt', 'any')),
  side           text not null check (side in ('debit', 'credit')),
  conta          text not null,
  account_name   text not null default '',
  hits           integer not null default 1 check (hits >= 1),
  confidence     numeric(4,3) not null default 0.850 check (confidence between 0 and 1),
  source         text not null default 'manual' check (source in ('manual', 'ai_auto', 'ai_accepted', 'batch')),
  sample_history text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (plan_id, history_key, direction, side)
);

comment on table public.conversor_chart_ai_rules is
  'Regras aprendidas pela IA do Conciliador (histórico normalizado -> conta do Plano de Contas).';

create index if not exists conversor_chart_ai_rules_plan_idx
  on public.conversor_chart_ai_rules (plan_id, updated_at desc);

create table if not exists public.conversor_chart_ai_tokens (
  plan_id    text not null references public.conversor_chart_plans(id) on delete cascade,
  token      text not null,
  conta      text not null,
  direction  text not null default 'any' check (direction in ('payment', 'receipt', 'any')),
  weight     numeric(6,2) not null default 1.00 check (weight between 0 and 100),
  hits       integer not null default 1 check (hits >= 1),
  updated_at timestamptz not null default now(),
  primary key (plan_id, token, conta, direction)
);

comment on table public.conversor_chart_ai_tokens is
  'Afinidade aprendida entre tokens de histórico e contas do Plano de Contas.';

alter table public.conversor_chart_plans enable row level security;
alter table public.conversor_chart_accounts enable row level security;
alter table public.conversor_chart_ai_rules enable row level security;
alter table public.conversor_chart_ai_tokens enable row level security;

drop policy if exists conversor_chart_plans_select_public on public.conversor_chart_plans;
create policy conversor_chart_plans_select_public on public.conversor_chart_plans for select to public using (true);

drop policy if exists conversor_chart_accounts_select_public on public.conversor_chart_accounts;
create policy conversor_chart_accounts_select_public on public.conversor_chart_accounts for select to public using (true);

drop policy if exists conversor_chart_ai_rules_select_public on public.conversor_chart_ai_rules;
create policy conversor_chart_ai_rules_select_public on public.conversor_chart_ai_rules for select to public using (true);

drop policy if exists conversor_chart_ai_tokens_select_public on public.conversor_chart_ai_tokens;
create policy conversor_chart_ai_tokens_select_public on public.conversor_chart_ai_tokens for select to public using (true);

revoke all on table public.conversor_chart_plans from anon, authenticated;
revoke all on table public.conversor_chart_accounts from anon, authenticated;
revoke all on table public.conversor_chart_ai_rules from anon, authenticated;
revoke all on table public.conversor_chart_ai_tokens from anon, authenticated;

grant select on table public.conversor_chart_plans to anon, authenticated;
grant select on table public.conversor_chart_accounts to anon, authenticated;
grant select on table public.conversor_chart_ai_rules to anon, authenticated;
grant select on table public.conversor_chart_ai_tokens to anon, authenticated;

-- ----------------------------------------------------------------------------
-- RPC: sincronizar / atualizar Plano de Contas (inserções, alterações, baixas)
-- ----------------------------------------------------------------------------
create or replace function public.conversor_chart_sync_plan(
  p_plan jsonb,
  p_accounts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_plan_id text := coalesce(nullif(trim(p_plan ->> 'id'), ''), 'default');
  v_company_code text := coalesce(trim(p_plan ->> 'company_code'), '');
  v_company_name text := coalesce(nullif(trim(p_plan ->> 'company_name'), ''), 'Plano de Contas Questor');
  v_cnpj text := coalesce(trim(p_plan ->> 'cnpj'), '');
  v_source_file text := coalesce(trim(p_plan ->> 'source_file'), '');
  v_version integer := 1;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_deactivated integer := 0;
  v_total integer := 0;
  v_analytic integer := 0;
  v_excluded integer := 0;
begin
  if jsonb_typeof(p_accounts) <> 'array' then
    raise exception 'p_accounts deve ser um array JSON';
  end if;

  insert into public.conversor_chart_plans (
    id, company_code, company_name, cnpj, source_file, version, created_at, updated_at
  )
  values (
    v_plan_id, v_company_code, v_company_name, v_cnpj, v_source_file, 1, now(), now()
  )
  on conflict (id) do update set
    company_code = case when excluded.company_code <> '' then excluded.company_code else public.conversor_chart_plans.company_code end,
    company_name = excluded.company_name,
    cnpj = case when excluded.cnpj <> '' then excluded.cnpj else public.conversor_chart_plans.cnpj end,
    source_file = case when excluded.source_file <> '' then excluded.source_file else public.conversor_chart_plans.source_file end,
    version = public.conversor_chart_plans.version + 1,
    updated_at = now()
  returning version into v_version;

  with incoming as (
    select distinct on (trim(item ->> 'conta'))
      trim(item ->> 'conta') as conta,
      coalesce(trim(item ->> 'classification'), '') as classification,
      coalesce(trim(item ->> 'name'), '') as name,
      coalesce(trim(item ->> 'alias'), '') as alias,
      coalesce(trim(item ->> 'group_path'), '') as group_path,
      coalesce((item ->> 'is_synthetic')::boolean, false) as is_synthetic,
      coalesce((item ->> 'is_counterparty')::boolean, false) as is_counterparty,
      coalesce(trim(item ->> 'nature'), '') as nature
    from jsonb_array_elements(p_accounts) as item
    where nullif(trim(item ->> 'conta'), '') is not null
      and nullif(trim(item ->> 'name'), '') is not null
  ),
  diff as (
    select
      i.*,
      (e.conta is null) as is_new,
      (e.conta is not null and (
        e.active = false
        or e.classification is distinct from i.classification
        or e.name is distinct from i.name
        or e.alias is distinct from i.alias
        or e.group_path is distinct from i.group_path
        or e.is_synthetic is distinct from i.is_synthetic
        or e.is_counterparty is distinct from i.is_counterparty
        or e.nature is distinct from i.nature
      )) as is_changed
    from incoming i
    left join public.conversor_chart_accounts e
      on e.plan_id = v_plan_id and e.conta = i.conta
  ),
  counts as (
    select
      count(*) filter (where is_new) as ins_count,
      count(*) filter (where is_changed) as upd_count,
      count(*) filter (where not is_new and not is_changed) as same_count,
      count(*) as tot_count,
      count(*) filter (where not is_synthetic and not is_counterparty) as ana_count,
      count(*) filter (where not is_synthetic and is_counterparty) as exc_count
    from diff
  ),
  upserted as (
    insert into public.conversor_chart_accounts (
      plan_id, conta, classification, name, alias, group_path,
      is_synthetic, is_counterparty, nature, active, updated_at
    )
    select
      v_plan_id, conta, classification, name, alias, group_path,
      is_synthetic, is_counterparty, nature, true, now()
    from diff
    where is_new or is_changed
    on conflict (plan_id, conta) do update set
      classification = excluded.classification,
      name = excluded.name,
      alias = excluded.alias,
      group_path = excluded.group_path,
      is_synthetic = excluded.is_synthetic,
      is_counterparty = excluded.is_counterparty,
      nature = excluded.nature,
      active = true,
      updated_at = now()
    returning 1
  ),
  deact as (
    update public.conversor_chart_accounts a
    set active = false, updated_at = now()
    where a.plan_id = v_plan_id
      and a.active = true
      and not exists (select 1 from incoming i where i.conta = a.conta)
    returning 1
  )
  select
    c.ins_count, c.upd_count, c.same_count,
    (select count(*) from deact),
    c.tot_count, c.ana_count, c.exc_count
  into
    v_inserted, v_updated, v_unchanged, v_deactivated,
    v_total, v_analytic, v_excluded
  from counts c;

  update public.conversor_chart_plans
  set
    total_accounts = v_total,
    analytic_accounts = v_analytic,
    excluded_counterparties = v_excluded,
    updated_at = now()
  where id = v_plan_id;

  return jsonb_build_object(
    'plan_id', v_plan_id,
    'company_code', v_company_code,
    'company_name', v_company_name,
    'cnpj', v_cnpj,
    'version', v_version,
    'inserted', v_inserted,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'deactivated', v_deactivated,
    'total_accounts', v_total,
    'analytic_accounts', v_analytic,
    'excluded_counterparties', v_excluded
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC: salvar aprendizados da IA (regras por histórico + afinidade por token)
-- ----------------------------------------------------------------------------
create or replace function public.conversor_chart_learn_batch(
  p_plan_id text,
  p_rules jsonb default '[]'::jsonb,
  p_tokens jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_plan_id text := coalesce(nullif(trim(p_plan_id), ''), '');
  v_rules_saved integer := 0;
  v_tokens_saved integer := 0;
begin
  if v_plan_id = '' or not exists (select 1 from public.conversor_chart_plans where id = v_plan_id) then
    return jsonb_build_object('ok', false, 'error', 'plan_not_found', 'rules_saved', 0, 'tokens_saved', 0);
  end if;

  if jsonb_typeof(p_rules) = 'array' and jsonb_array_length(p_rules) > 0 then
    with raw_rules as (
      select distinct on (
        extensions.conversor_norm_text(item ->> 'history_key'),
        coalesce(nullif(trim(item ->> 'direction'), ''), 'any'),
        case when trim(item ->> 'side') = 'credit' then 'credit' else 'debit' end
      )
        extensions.conversor_norm_text(item ->> 'history_key') as history_key,
        case
          when trim(item ->> 'direction') in ('payment', 'receipt', 'any') then trim(item ->> 'direction')
          else 'any'
        end as direction,
        case when trim(item ->> 'side') = 'credit' then 'credit' else 'debit' end as side,
        trim(item ->> 'conta') as conta,
        coalesce(trim(item ->> 'account_name'), '') as account_name,
        greatest(1, coalesce((item ->> 'hits')::integer, 1)) as hits,
        least(1.0, greatest(0.1, coalesce((item ->> 'confidence')::numeric, 0.85))) as confidence,
        case
          when trim(item ->> 'source') in ('manual', 'ai_auto', 'ai_accepted', 'batch') then trim(item ->> 'source')
          else 'manual'
        end as source,
        left(extensions.conversor_scrub_text(coalesce(trim(item ->> 'sample_history'), '')), 200) as sample_history
      from jsonb_array_elements(p_rules) as item
      where nullif(extensions.conversor_norm_text(item ->> 'history_key'), '') is not null
        and nullif(trim(item ->> 'conta'), '') is not null
    ),
    ins_rules as (
      insert into public.conversor_chart_ai_rules (
        plan_id, history_key, direction, side, conta, account_name,
        hits, confidence, source, sample_history, created_at, updated_at
      )
      select
        v_plan_id, history_key, direction, side, conta, account_name,
        hits, confidence, source, sample_history, now(), now()
      from raw_rules
      on conflict (plan_id, history_key, direction, side) do update set
        conta = excluded.conta,
        account_name = case when excluded.account_name <> '' then excluded.account_name else public.conversor_chart_ai_rules.account_name end,
        hits = case
          when public.conversor_chart_ai_rules.conta = excluded.conta
            then public.conversor_chart_ai_rules.hits + excluded.hits
          else excluded.hits
        end,
        confidence = case
          when public.conversor_chart_ai_rules.conta = excluded.conta
            then least(0.999, greatest(public.conversor_chart_ai_rules.confidence, excluded.confidence) + 0.020)
          else excluded.confidence
        end,
        source = excluded.source,
        sample_history = case when excluded.sample_history <> '' then excluded.sample_history else public.conversor_chart_ai_rules.sample_history end,
        updated_at = now()
      returning 1
    )
    select count(*) into v_rules_saved from ins_rules;
  end if;

  if jsonb_typeof(p_tokens) = 'array' and jsonb_array_length(p_tokens) > 0 then
    with raw_tokens as (
      select
        extensions.conversor_norm_text(item ->> 'token') as token,
        trim(item ->> 'conta') as conta,
        case
          when trim(item ->> 'direction') in ('payment', 'receipt', 'any') then trim(item ->> 'direction')
          else 'any'
        end as direction,
        least(50.0, greatest(0.1, sum(coalesce((item ->> 'weight')::numeric, 1.0)))) as weight,
        greatest(1, sum(coalesce((item ->> 'hits')::integer, 1)))::integer as hits
      from jsonb_array_elements(p_tokens) as item
      where length(extensions.conversor_norm_text(item ->> 'token')) >= 2
        and nullif(trim(item ->> 'conta'), '') is not null
      group by 1, 2, 3
    ),
    ins_tokens as (
      insert into public.conversor_chart_ai_tokens (
        plan_id, token, conta, direction, weight, hits, updated_at
      )
      select
        v_plan_id, token, conta, direction, weight, hits, now()
      from raw_tokens
      on conflict (plan_id, token, conta, direction) do update set
        weight = least(100.0, public.conversor_chart_ai_tokens.weight + excluded.weight),
        hits = public.conversor_chart_ai_tokens.hits + excluded.hits,
        updated_at = now()
      returning 1
    )
    select count(*) into v_tokens_saved from ins_tokens;
  end if;

  return jsonb_build_object(
    'ok', true,
    'plan_id', v_plan_id,
    'rules_saved', v_rules_saved,
    'tokens_saved', v_tokens_saved
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC: carregar planos salvos, contas ativas e aprendizados da IA
-- ----------------------------------------------------------------------------
create or replace function public.conversor_chart_load(
  p_plan_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_plan_id text;
  v_plans jsonb;
  v_plan jsonb;
  v_accounts jsonb;
  v_rules jsonb;
  v_tokens jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(p) order by p.updated_at desc), '[]'::jsonb)
  into v_plans
  from public.conversor_chart_plans p;

  if nullif(trim(p_plan_id), '') is not null then
    select id into v_plan_id from public.conversor_chart_plans where id = trim(p_plan_id);
  end if;

  if v_plan_id is null then
    select id into v_plan_id from public.conversor_chart_plans order by updated_at desc limit 1;
  end if;

  if v_plan_id is null then
    return jsonb_build_object(
      'plans', v_plans,
      'plan', null,
      'accounts', '[]'::jsonb,
      'rules', '[]'::jsonb,
      'tokens', '[]'::jsonb
    );
  end if;

  select to_jsonb(p) into v_plan
  from public.conversor_chart_plans p
  where p.id = v_plan_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'conta', a.conta,
      'classification', a.classification,
      'name', a.name,
      'alias', a.alias,
      'group_path', a.group_path,
      'is_synthetic', a.is_synthetic,
      'is_counterparty', a.is_counterparty,
      'nature', a.nature
    ) order by a.classification, a.conta
  ), '[]'::jsonb)
  into v_accounts
  from public.conversor_chart_accounts a
  where a.plan_id = v_plan_id and a.active = true;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'history_key', r.history_key,
      'direction', r.direction,
      'side', r.side,
      'conta', r.conta,
      'account_name', r.account_name,
      'hits', r.hits,
      'confidence', r.confidence,
      'source', r.source,
      'sample_history', r.sample_history,
      'updated_at', r.updated_at
    ) order by r.hits desc, r.updated_at desc
  ), '[]'::jsonb)
  into v_rules
  from public.conversor_chart_ai_rules r
  where r.plan_id = v_plan_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'token', t.token,
      'conta', t.conta,
      'direction', t.direction,
      'weight', t.weight,
      'hits', t.hits
    )
  ), '[]'::jsonb)
  into v_tokens
  from public.conversor_chart_ai_tokens t
  where t.plan_id = v_plan_id;

  return jsonb_build_object(
    'plans', v_plans,
    'plan', v_plan,
    'accounts', v_accounts,
    'rules', v_rules,
    'tokens', v_tokens
  );
end;
$$;

grant execute on function public.conversor_chart_sync_plan(jsonb, jsonb) to anon, authenticated, service_role;
grant execute on function public.conversor_chart_learn_batch(text, jsonb, jsonb) to anon, authenticated, service_role;
grant execute on function public.conversor_chart_load(text) to anon, authenticated, service_role;

analyze public.conversor_chart_plans;
analyze public.conversor_chart_accounts;
analyze public.conversor_chart_ai_rules;
analyze public.conversor_chart_ai_tokens;

notify pgrst, 'reload schema';
