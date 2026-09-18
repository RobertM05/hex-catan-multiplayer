-- AUTH-05: check_user_exists RPC and auto_confirm trigger for fast dev & friction-free auth

create or replace function public.check_user_exists(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (select 1 from auth.users where lower(email) = lower(trim(p_email)));
end;
$$;

grant execute on function public.check_user_exists(text) to anon, authenticated;

-- Auto-confirm newly inserted users to avoid default SMTP rate-limiting on self-hosted/free tiers
create or replace function public.handle_auto_confirm_user()
returns trigger
language plpgsql
security definer
as $$
begin
  new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  new.confirmed_at := coalesce(new.confirmed_at, now());
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_auto_confirm on auth.users;
create trigger on_auth_user_created_auto_confirm
  before insert on auth.users
  for each row execute function public.handle_auto_confirm_user();
