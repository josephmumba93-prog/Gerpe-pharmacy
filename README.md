# Gerpe Pharmacy — Management System

A complete web-based pharmacy management system: products, purchases, sales,
suppliers, categories, dashboard, reports, stock alerts, user roles, and
app settings. Single `index.html` + `app.js`, backed by Supabase, deployed
on GitHub Pages — same pattern as your other projects.

---

## 1. Set up Supabase (database)

1. Go to your Supabase project → **SQL Editor**.
2. Open `schema.sql` from this folder, copy the **entire file**, paste it
   into the SQL Editor, and click **Run**. This creates all tables, the
   automatic stock triggers, views, and security rules in one go.
3. Go to **Authentication → Providers** and make sure **Email** is enabled.
   For internal staff-only use, you can turn **OFF** "Confirm email" under
   Authentication → Settings, so new accounts can log in immediately without
   clicking a confirmation email.

## 2. Create your first user (yourself, as Admin)

1. Go to **Authentication → Users → Add user**.
   - Enter your email and a password.
   - Tick "Auto Confirm User" if that option appears.
2. Go back to **SQL Editor** and run this (replace with your real email):

   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'YOUR_EMAIL_HERE');
   ```

   This promotes your account to Admin. Every new sign-up defaults to
   **Staff** automatically — promote others the same way, or later from
   the in-app **Users** page once you're logged in as Admin.

## 3. Connect the app to your Supabase project

1. In Supabase, go to **Project Settings → API**.
2. Copy your **Project URL** and **anon public key**.
3. Open `app.js` in this folder, find these two lines near the top:

   ```js
   const SUPABASE_URL = "YOUR_SUPABASE_URL_HERE";
   const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY_HERE";
   ```

4. Replace both placeholder values with your real Project URL and anon key.
   Save the file.

> The anon key is safe to expose in frontend code — it only allows what your
> Row Level Security rules (already set up by `schema.sql`) permit:
> logged-in, active staff/admin accounts only.

## 4. Deploy to GitHub Pages

1. Create a new GitHub repository (e.g. `gerpe-pharmacy`).
2. Drag and drop `index.html` and `app.js` into it (same as your other
   GitHub Pages projects), commit.
3. Go to **Settings → Pages**, set source to your main branch / root,
   save.
4. Your app will be live at `https://yourusername.github.io/gerpe-pharmacy/`
   within a minute or two.

## 5. Adding more staff later

New login accounts must be created from the **Supabase Dashboard**
(Authentication → Users → Add user) — this is a deliberate security
choice: the app's anon key is never allowed to create accounts directly,
only Supabase's protected admin panel can. Once an account is created
there, it appears automatically in the app's **Users** page (as Staff by
default), where an Admin can promote it, rename it, or deactivate it.

---

## What's included

**Core business functions**
- **Products** — full catalog with cost/selling price, stock quantity,
  reorder level, expiry date. Automatic status badges: OK / Low Stock /
  Out of Stock / Expiring Soon / Expired.
- **Purchases** — record stock coming in; product quantity increases
  automatically via a database trigger (no manual math, no risk of drift).
- **Sales** — record items sold; quantity decreases automatically, and
  overselling is blocked at the database level (can't sell more than
  what's in stock).
- **Suppliers** — manage supplier contacts, see how many products link
  to each.
- **Categories** — organize products, see product counts per category.

**Supporting features**
- **Dashboard** — today's sales, out-of-stock/low-stock/expired counts,
  a 14-day sales trend chart, live stock alerts, recent sales feed.
- **Reports** — date-range filtered: sales by product (with estimated
  profit), purchases by supplier, current inventory valuation. Every
  list page also has Export CSV and Print buttons.
- **Stock notifications** — the moment a sale drops a product to zero or
  below its reorder level, a notification is generated automatically
  (via a database trigger) and shows up in the bell icon.
- **Access control** — two roles, Admin and Staff. Admin-only areas
  (Users, Settings) are hidden from Staff in the sidebar and blocked at
  the database level even if someone tries to call the API directly.
- **User management** — Admins can rename staff, promote/demote
  Admin↔Staff, and activate/deactivate accounts.
- **App settings** — pharmacy name, address, contact info, currency,
  default reorder level, expiry warning window, receipt footer note.
- **Backup** — handled automatically by Supabase's own database backups
  (Project → Database → Backups in your dashboard). No in-app action
  needed.

## Notes on the data model

- One expiry date per product (not per batch) — keeps purchases simple:
  receiving new stock of an existing product just adds to its quantity
  and updates its cost price.
- Every sale and purchase row stores who recorded it (`created_by`),
  visible in the Purchases/Sales tables for accountability.
- Deleting a purchase or sale automatically reverses its effect on stock
  (deleting a sale gives the stock back; deleting a purchase removes it
  again), so your numbers stay consistent if you need to correct a
  mistake.
