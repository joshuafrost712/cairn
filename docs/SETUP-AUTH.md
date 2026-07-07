# Setting up Supabase Auth for Throughline

This guide walks you through connecting Throughline to a Supabase project so that
real email/password login works. Without these steps the app runs in local-only
mode (identity stored on-device, no backend sync).

## 1. Create a free Supabase project

1. Go to https://supabase.com and sign in.
2. Click **New project**. Choose any name (e.g. `cairn`), pick a region close to
   your users, set a strong database password, and click **Create new project**.
3. Wait for provisioning to finish (about a minute).

## 2. Run the migrations

The repo is set up for the Supabase CLI, so the recommended path is `db push`.
From the repo root:

```bash
supabase login                          # opens a browser to authorize (once)
supabase link --project-ref <YOUR-REF>  # ref = the subdomain of your project URL
supabase db push                        # applies all four migrations in order
```

Your project ref is the `xxxx` in `https://xxxx.supabase.co` (also under
**Project Settings > General**). `link` will prompt for the database password you
set when creating the project. `db push` reads the local files in
`supabase/migrations/` (they do not need to be committed):

1. `20260608000100_foundation_schema.sql`
2. `20260608000200_quick_ratings_focus_short_label.sql`
3. `20260706000300_auth_and_roles.sql` (this is the one that enables login)
4. `20260706000400_mentoring_conversation.sql` (mentoring sync; not required for login)

Important: if you already ran any of these by hand in the SQL Editor, `db push`
will fail because the objects already exist but the CLI has no record of them.
In that case either push to a fresh project, or tell the CLI they are already
applied without re-running:

```bash
supabase migration repair --status applied 20260608000100 20260608000200 20260706000300 20260706000400
```

You can still paste files individually in the **SQL Editor** if you prefer, but
then use the whole-project push above for future changes.

## 3. Configure the Email provider

In the Supabase dashboard go to **Authentication > Providers > Email** and make
sure it is **enabled**.

For the demo (Bali pilot) you should also **turn off "Confirm email"**:

- In **Authentication > Email Templates**, or
- Under **Authentication > Settings > Auth**, uncheck **"Enable email confirmations"**.

This lets a new account be used immediately after signup without a confirmation
step. The code handles the case where confirmation is required (it shows a
"check your email" screen), but for the workshop keeping it off avoids friction.

## 4. Copy the project credentials into .env

In the Supabase dashboard go to **Project Settings > API**. Copy:

- **Project URL** (looks like `https://xxxx.supabase.co`)
- **anon public** key

Create a `.env` file at the repo root (copy `.env.example`) and fill in:

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

Then restart the dev server:

```bash
npm run dev
```

The sign-in screen will now show email+password fields instead of the local-only
name+email form.

## 5. GitHub Pages / deployed PWA

The deployed build needs these values at build time. Add them as repository
secrets in **GitHub > Settings > Secrets and variables > Actions**:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Then reference them in your workflow (`.github/workflows/*.yml`) under
`env:` so Vite picks them up during `npm run build`.

## 6. Making an account a chief evaluator

There are two options:

**At signup (demo convenience):** select "Chief Evaluator" from the role dropdown
on the Create account screen. The `handle_new_user()` trigger will set that role
on the `app_user` row automatically.

**After the fact:** go to **Table Editor > app_user** in the Supabase dashboard,
find the user's row, and change the `role` column to `chief_evaluator`. The next
time they sign in, the app will read the updated role from `app_user`.

## 7. How offline tolerance works

Supabase-js persists the session token in `localStorage` by default
(`persistSession: true`). After a successful online sign-in, the session is
readable on the next app load even without a network connection. Token refresh
will fail while offline, but the cached user object is still available, so the
app continues to show the correct identity and let the evaluator capture
observations. When the device comes back online the session refreshes
automatically.

The 30-day custom expiry used in local-only mode does NOT apply when Supabase
is configured; session lifetime is controlled by Supabase Auth settings (default:
1 hour access token, 7-day refresh window with rolling expiry).
