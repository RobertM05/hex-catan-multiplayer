-- #224: Add avatar_url column to profiles for persisted avatar choice
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url text;
