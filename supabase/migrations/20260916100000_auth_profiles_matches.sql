-- AUTH-01: profiles, matches, match_players, unused ratings, RLS.
-- Apply on a fresh Supabase project (SQL editor or `supabase db push`).
-- Service role (game server) bypasses RLS and writes matches.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  ad_free boolean not null default false,
  created_at timestamptz not null default now(),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 32),
  constraint profiles_display_name_chars check (display_name !~ '[<>]'),
  constraint profiles_display_name_unique unique (display_name)
);

create table if not exists public.matches (
  id uuid primary key,
  started_at timestamptz not null,
  ended_at timestamptz not null default now(),
  mode text not null,
  ranked boolean not null default false,
  room_code text not null,
  expansion_cities_knights boolean not null default false
);

create unique index if not exists matches_room_ended_uidx
  on public.matches (room_code, ended_at);

create table if not exists public.match_players (
  match_id uuid not null references public.matches (id) on delete cascade,
  seat_index integer not null,
  user_id uuid null references public.profiles (id) on delete set null,
  display_name text not null,
  vp integer not null default 0,
  rank integer not null,
  abandoned boolean not null default false,
  primary key (match_id, seat_index),
  constraint match_players_rank_range check (rank between 1 and 8)
);

-- AUTH-01: table exists; nothing writes Elo until RANK-01.
create table if not exists public.ratings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  elo integer not null default 1000,
  games integer not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base text;
  candidate text;
  suffix integer := 0;
begin
  base := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Player'
  );
  base := left(regexp_replace(base, '[<>]', '', 'g'), 32);
  if base = '' then
    base := 'Player';
  end if;
  candidate := base;
  while exists (select 1 from public.profiles where display_name = candidate) loop
    suffix := suffix + 1;
    candidate := left(base, greatest(1, 32 - length(suffix::text))) || suffix::text;
  end loop;
  insert into public.profiles (id, display_name, ad_free)
  values (new.id, candidate, false);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
alter table public.ratings enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

drop policy if exists "profiles_update_own_name" on public.profiles;
create policy "profiles_update_own_name"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "match_players_select_own" on public.match_players;
create policy "match_players_select_own"
  on public.match_players for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "matches_select_own_rows" on public.matches;
create policy "matches_select_own_rows"
  on public.matches for select
  to authenticated
  using (
    exists (
      select 1 from public.match_players mp
      where mp.match_id = matches.id and mp.user_id = auth.uid()
    )
  );

-- ratings: readable by owner later; no client writes in Phase 0.
drop policy if exists "ratings_select_own" on public.ratings;
create policy "ratings_select_own"
  on public.ratings for select
  to authenticated
  using (user_id = auth.uid());

grant usage on schema public to authenticated, anon;
grant select, update on public.profiles to authenticated;
grant select on public.matches to authenticated;
grant select on public.match_players to authenticated;
grant select on public.ratings to authenticated;
