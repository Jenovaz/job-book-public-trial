# Job Book — public trial

A phone-friendly client run sheet, work-hours log and payment tracker for a small cleaning team. This repository contains a **fictional browser demo** and the source for a separate Cloudflare Workers + D1 deployment.

**[Try the browser demo](https://jenovaz.github.io/job-book-public-trial/)** · [Source code](https://github.com/Jenovaz/job-book-public-trial)

## Try it safely

The browser demo includes eight invented clients, sample visits and notes. Open it, expand a client, mark work done, edit hours, and explore the Money and Week views. Your changes stay in that browser's storage. **The demo has no sign-in, no shared sync and no photo storage. Do not enter real customer information.** Use **Reset demo** to return to the fictional starting records.

This is a separate copy. It has no connection to any existing production Job Book database.

## Run the full app locally

Requirements: Node.js, Python 3 and a Cloudflare account. No paid Cloudflare service is used by this project.

```powershell
git clone https://github.com/Jenovaz/job-book-public-trial.git
cd job-book-public-trial
npm ci
Copy-Item .dev.vars.example .dev.vars
python build.py
npx wrangler d1 execute job-book-your-business --local --file=./schema.sql
npx wrangler d1 execute job-book-your-business --local --file=./seed.sql
npx wrangler dev --local --port 8788
```

Open <http://127.0.0.1:8788> and use the **local test passphrase** from `.dev.vars.example`. The local database contains only fictional records. On a fresh local database, run `node _test.cjs` in another terminal to check the API. The test deliberately adds, edits and removes local test records.

The `.dev.vars` file is ignored by Git. Replace its values if you use a local copy for anything beyond testing.

## Deploy your own private copy

Each business needs its **own Cloudflare account, Worker and D1 database**. The public browser demo must not be used as a shared client database.

1. Run `npx wrangler d1 create job-book-your-business` and paste the new database ID into `wrangler.toml`. Change the Worker and database names there if needed. The checked-in ID is a placeholder and cannot target the original business's database.
2. Run `npx wrangler d1 execute job-book-your-business --remote --file=./schema.sql` to create the tables. For a brand-new, empty database, you may run the same command with `seed.sql` to add **fictional** sample records. Never run `seed.sql` on a database that already holds your real data.
3. Run `npx wrangler deploy`.
4. Set your own secrets interactively with `npx wrangler secret put PASSPHRASE` and `npx wrangler secret put SESSION_SECRET`. Use a long, unique shared passphrase and a separate long random signing secret. Do not commit them or put them in command arguments. The app rejects sign-in until both secrets are set.

The Worker stores clients, visits, notes, settings and optional compressed photos in your D1 database. Edits save on the phone first and sync when a connection returns. The same client record uses the latest `updatedAt` value when two devices edit it; notes are separate records so both teammates' notes survive.

## What it does

- Today and Calendar: recurring or one-off jobs, date moves and completion.
- Clients and Former: searchable client briefs, notes, photos in the Worker copy, status and reactivation.
- Hours and Week: hours actually logged, separated from planned work.
- Money: invoices, unpaid work, payments and planned weekly client total based on booking terms.
- Phone-first controls: tap a client name or avatar to expand, use **Expand all** or **Minimise all**, and use **Edit client** on each card.

The full app is designed for one small team sharing a passphrase. It does **not** offer separate staff accounts, permissions, hosted multi-business sign-up or a central service. It is a self-deployed trial, not a ready-made SaaS product. The local demo and Worker use Australian English, AUD and Sunday-to-Saturday work weeks; change those rules in `index.html` for a different region.

## Project files

| File | Purpose |
| --- | --- |
| `index.html` | Standalone fictional demo and UI source |
| `build.py` | Generates `src/app.html` and `seed.sql` |
| `_sync.js` | Offline-first sync for the Worker build |
| `src/index.js` | Login, sync and photo API |
| `schema.sql` | D1 table definitions |
| `seed.sql` | Generated fictional starting records |
| `_check.cjs`, `_test.cjs` | Syntax and local API checks |

Edit `index.html`, then run `python build.py` and `node _check.cjs`. `src/app.html` and `seed.sql` are generated; don't edit them directly.

## Licence

No reuse licence is granted at this stage. You may inspect and try the demo. Contact the owner before copying or adapting the code for your own business.
