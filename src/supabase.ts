import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// null when the env vars are missing, so tests and offline builds do not crash.
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null
