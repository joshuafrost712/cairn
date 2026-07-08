import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/**
 * The app runs in LOCAL-ONLY mode when Supabase isn't configured: capture and
 * offline persistence work, but nothing syncs. This keeps the foundation slice
 * runnable before a backend exists.
 *
 * createClient throws on a malformed URL, and because this module is evaluated
 * at app startup, an unguarded throw here blanks the entire app (this happened
 * when a whole `.env` line was pasted as the deploy secret's value). Treat bad
 * config the same as no config: fall back to local-only mode.
 */
function tryCreateClient(): SupabaseClient | null {
  if (!url || !anonKey) return null
  try {
    return createClient(url, anonKey)
  } catch (err) {
    console.error('Supabase config invalid; running in local-only mode.', err)
    return null
  }
}

export const supabase: SupabaseClient | null = tryCreateClient()

export const isSupabaseConfigured = supabase !== null
