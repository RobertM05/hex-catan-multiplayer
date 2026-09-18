-- Allow authenticated users to insert their own profile row if it doesn't already exist
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());

GRANT INSERT ON public.profiles TO authenticated;
