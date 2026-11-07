# VIN & Vehicle History Card

One Netlify site with one folder per product. Each product page only accepts logins of that product,
and each product has its own VIN list, serial counter, print log and card.

## Folder structure

```
public/
  index.html            start page with a link to each product (no login on it)
  shared/
    app.js              the program, shared by all products (fix a bug here once)
    style.css           the look of the pages and of the printed card
  scooter/              https://your-site/scooter/
    index.html
    product.js          name, card heading and checklist, model/colour suggestions
  atomplus/             https://your-site/atomplus/
    index.html
    product.js
  atomdlx/              https://your-site/atomdlx/
    index.html
    product.js
  maxmile/              https://your-site/maxmile/
    index.html
    product.js
netlify/functions/api.js   proxy: checks logins, issues signed sessions, hides the Apps Script address
netlify.toml               publish folder, the /api redirect, browser security headers
Code.gs                    Google Apps Script backend (users, VINs, print log, audit log)
.env.example               the Netlify settings you need
```

To change what is specific to one product (its card checklist, heading, model or colour suggestions), edit
only that product's `product.js`. To change how the program behaves for everyone, edit `public/shared/app.js`.

## How logins work

1. Staff open their product's page, for example `/atomplus/`, and type an **ID and password**.
2. The Apps Script checks them against the **Users** tab of the Google Sheet. The Product column says which product the ID belongs to.
3. A login of one product is refused on another product's page ("This login is not for Atom Plus").
4. The server returns a signed session token (8 hours). The browser keeps only the token, never the password, and each product page keeps its own session.
5. Every request is checked again: the user must still be active, on the same product, with the same password.
6. Five wrong passwords lock that ID for 15 minutes. The page also locks itself after 30 minutes without use.

## VIN formats

`VIN = prefix + month letter + year + L + serial` (17 characters). Set in `PRODUCTS` in `Code.gs`.

| Product (`Users` key) | Prefix | Year part | Serial | Example |
|---|---|---|---|---|
| E-Scooter (`scooter`) | `MAP1SRBP` | 2 digits | 5 digits | `MAP1SRBPL26L00015` |
| Atom Plus (`atomplus`) | `MAP4ECBP` | 2 digits | 5 digits | `MAP4ECBPD23L01249` |
| Atom DLX (`atomdlx`) | `MAP4EMBP` | 1 letter (2026 = T) | 6 digits | `MAP4EMBPKTL000567` |
| Max Mile (`maxmile`) | `MAP3TGBP` | 2 digits | 5 digits | `MAP3TGBPK26L00007` |

Month letters: A Jan, B Feb, C Mar, D Apr, E May, F Jun, G Jul, H Aug, J Sep, K Oct, L Nov, M Dec (no I).
Year letters (Atom DLX): 2025 S, 2026 T, 2027 V, 2028 W, 2029 X, 2030 Y, 2031 1.
To change a prefix or serial length, edit `PRODUCTS` in `Code.gs` and deploy a new Apps Script version.

## Setup

### 1. Google Sheet and Apps Script
1. Open the Sheet > Extensions > Apps Script and paste `Code.gs`.
2. Set `ACCESS_KEY` to a long random value (24+ characters). The script refuses to run with the default.
3. Check the VIN `prefix` of each product in `PRODUCTS`, and set `initialSerial` if a product must continue from an existing number.
4. Run `setup()` once. It creates the **Users**, **AuditLog**, and per-product VIN and print-log tabs.
5. Open the **Users** tab. For each person fill in ID, Password, Product (`scooter`, `atomplus`, `atomdlx` or `maxmile`) and set Active to `YES`.
   Add as many rows as needed; several people can share a product.
6. Deploy > Manage deployments > Edit > New version (Execute as: Me, Who has access: Anyone).

Passwords typed in plain text are converted to a protected form at that user's next login
(or run `hashPasswords()` to convert them now). To change a password, type the new one in the cell.
Setting Active to `NO`, changing a password or changing a product ends that user's open sessions.

### 2. Netlify
1. Deploy this repository (publish folder `public`, functions folder `netlify/functions`; both are set in `netlify.toml`).
2. Add the environment variables from `.env.example`: `APPS_SCRIPT_URL`, `SCRIPT_KEY`, `SESSION_SECRET` (and optionally `SESSION_HOURS`).
   Make a random value with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. Redeploy after changing variables.

`LOGIN_KEY` and `LOGINS` from older versions are no longer used; you can delete them.

### 3. Test locally (optional)
Install the Netlify CLI (`npm install -g netlify-cli`), copy `.env.example` to `.env`, fill it in, run `netlify dev`
and open `http://localhost:8888/scooter/` (or another product folder). Do not open the files directly.

## Adding another product

1. In `Code.gs`, add an entry to `PRODUCTS` (prefix, year style, serial length, sheet names) and run `setup()` again.
2. Copy one product folder in `public/` (for example `scooter/`), rename it, and edit its `product.js` (`id` must equal the key in `PRODUCTS`) and the names in its `index.html`.
3. Add a link for it in `public/index.html` and a row for it in the Users tab.

## Card checklists

Atom Plus, Atom DLX and Max Mile currently use the E-Scooter checklist with their own heading. Replace the lists
`s1l`, `s1r`, `s2l`, `s2r`, `s3l` (English and Hindi) in each product's own `product.js` with the real checklist.

## Security summary

- The Apps Script address and key stay on the server.
- Passwords are stored as a keyed hash; the key is in Script Properties, not in the Sheet.
- Users and AuditLog tabs are owner-only. Every login, lockout, VIN generation and print is logged in AuditLog.
- Security headers, including a Content-Security-Policy that only allows scripts from the site's own files, are set in `netlify.toml`.
- Anyone with direct access to the Google Sheet can still read the VIN tabs, so share the Sheet with as few people as possible.
