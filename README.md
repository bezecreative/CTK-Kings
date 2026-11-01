# Christ The King — Kids Check-In

A check-in station for kids ministry. Parents find their family by name or
phone, tap the kids who are here, and labels print on a Zebra ZD421:
one label per child plus a parent pickup tag that share the same 4-character
pickup code. Staff use `/admin` for the live roster, families, CSV import,
label settings and exports.

* **Kiosk (parents):** `/` — no PIN needed (can be switched on in Settings)
* **Admin (staff):** `/admin` — protected by the admin PIN

Classrooms are assigned by age: **Nursery** (through age 3), **PreK-2nd**
(4–7), **3rd-5th** (8–11). Edit the ages in Settings, or pick a classroom for an
individual child.

---

## 1. Run it on this computer (optional, for trying it out)

Needs only Python 3 (already on macOS). No install step.

```bash
python3 run_local.py
```

Then open <http://localhost:8000> (kiosk) and <http://localhost:8000/admin>.
Data lives in `data/checkin.db` (ignored by git). The local test PINs are in
`data/local-test-pins.txt`.

## 2. Put it online (GitHub + Vercel)

1. Push this folder to a GitHub repository (private is fine — the member list
   itself is never committed; `*.csv` and `data/` are git-ignored).
2. In Vercel: **Add New → Project → Import** the repository. Leave the settings
   as they are (`vercel.json` tells Vercel what to do) and click **Deploy**.
3. Add a database: in the Vercel project open **Storage → Create Database →
   Neon (Postgres)** (free tier). Accept the defaults and connect it to the
   project. Vercel adds a `DATABASE_URL` environment variable for you.
   *(Supabase or Prisma Postgres also work — the app reads `DATABASE_URL`,
   `POSTGRES_URL` or `DATABASE_URL_UNPOOLED`.)*
4. **Deployments → ⋯ → Redeploy** so the new variable is picked up.
5. Open `https://<your-project>.vercel.app/admin` and choose your admin PIN.
   That's the whole setup; the tables are created automatically.

Optional environment variables (Vercel → Settings → Environment Variables):

| Variable      | Purpose |
|---------------|---------|
| `ADMIN_PIN`   | Emergency master PIN if the admin PIN is forgotten. |
| `APP_SECRET`  | Signs the login tokens. Set once to any long random string; otherwise one is generated and stored in the database. |

## 3. Import your families

Admin → **Import CSV** → drop the export from your church software.

* People who share a phone number, or a last name + street address, are
  grouped into one household.
* Kids are guessed from the contact info (a child usually has a parent's email
  or phone copied onto their row, or none at all). Households marked **check**
  had an uncertain guess — set each person to Parent / Child / Skip before
  pressing Import. Organisation rows ("… org") are skipped automatically.
* Birthdays aren't in the export. Parents add them at the kiosk the first time
  they check in (the kiosk asks), or staff can add them under Families.
* Re-importing a newer export later only adds people who aren't already there.

## 4. The check-in computer and the Zebra ZD421

**Printing (recommended): Zebra Browser Print.** It is Zebra's free helper app
that lets a web page print straight to a USB or network Zebra printer, with no
print dialog.

1. Plug in the ZD421 (USB) and load your labels. The app's default label is
   **3 × 2 in** at 203 dpi — change it in Admin → Settings → Labels if your
   stock differs (there are presets, and an exact preview of what the printer
   receives).
2. Install Zebra Browser Print on the check-in computer (Windows or Mac):
   <https://www.zebra.com/us/en/support-downloads/printer-software/by-request-software.html#browser-print>
   (Zebra asks for an email, then sends the download). Start it; it runs in the
   background and shows a small Zebra icon.
3. Open the kiosk site in Chrome (or Edge/Firefox). The first time the site
   talks to Browser Print, a Zebra window pops up asking whether to allow the
   site — click **Allow/Yes**. (Safari also needs you to visit
   `https://127.0.0.1:9101` once and accept its certificate; Chrome is easier.)
4. Admin → Settings → **Printing → Detect printers**, pick the ZD421, then
   **Test print**. The printer choice is remembered per computer.

**Fallback: the browser print dialog.** Choose *Browser print dialog* in
Settings → Printing if you'd rather use the normal Zebra driver. Each check-in
then opens the print dialog with the labels sized to your stock. To skip the
dialog, start Chrome with `--kiosk-printing` and set the ZD421 as the default
printer.

**Kiosk tips.** Open the kiosk URL in Chrome and press F11 / full-screen. The
screen returns to the start automatically after each check-in and after a
few minutes of inactivity.

## 5. Pickup codes

Every check-in gets a code like `K7Q2`. It prints on each child's label and on
the parent tag (which lists the children). At pickup, compare the parent's tag
with the child's label — or type the code into the **Pickup check** box on
Admin → Today to see exactly which kids it belongs to.

## 6. Everyday staff tasks

* **Today** — live roster per classroom with ages, allergies, notes and codes;
  reprint a label or remove a mistaken check-in.
* **Families** — search, edit parents/children (birthday, allergies, notes,
  classroom), add a family, or remove one.
* **Settings** — church name (printed on labels), classrooms and ages, label
  size and contents, print method, kiosk auto-return, PINs.
* **Export** — families CSV and check-in history CSV for any date range.

## 7. Changing the logo

Replace `public/img/logo.png` (any PNG with a transparent background works;
it is shown about 80 px tall on the kiosk).

## Notes

* The kiosk page is open to anyone who has the URL (that's how a kiosk works).
  If you'd rather lock it, turn on *Require a PIN to unlock check-in devices*
  in Settings → PINs; each device then asks once for the kiosk PIN.
* Labels are generated as ZPL on the server (`lib/labels.py`); the on-screen
  previews mirror the same layout.
* Project layout: `api/index.py` (Vercel entry) → `lib/app.py` (API) →
  `lib/db.py` (SQLite locally / Postgres on Vercel), `lib/importer.py` (CSV
  grouping), `public/` (kiosk and admin pages, plain HTML/JS).
