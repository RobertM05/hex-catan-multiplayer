-- AUTH-01 SQL smoke (run in Supabase SQL editor after the migration).
-- 1) Profile insert + unique display_name conflict.
-- 2) Confirm ratings exists and stays unused.

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000001', 'alice@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'alice2@example.com');

-- Trigger should have created distinct display names.
select id, display_name from public.profiles
where id in (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002'
);

-- Direct unique conflict:
insert into public.profiles (id, display_name)
values ('00000000-0000-0000-0000-000000000003', (
  select display_name from public.profiles
  where id = '00000000-0000-0000-0000-000000000001'
));
-- Expected: ERROR unique violation on profiles_display_name_unique.

select to_regclass('public.ratings') as ratings_table;

-- Cleanup (optional)
-- delete from auth.users where id in (
--   '00000000-0000-0000-0000-000000000001',
--   '00000000-0000-0000-0000-000000000002'
-- );
