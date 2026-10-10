# VIN & Vehicle History Card – Netlify proxy

```
public/index.html              the website (calls /api only)
netlify/functions/api.js       proxy function (holds the Apps Script URL and key)
netlify.toml                   publish folder + /api redirect + security headers
Code.gs                        Google Apps Script backend (paste into the Sheet's script editor)
.env.example                   the 3 settings to enter in Netlify
```

## Set up
1. **Apps Script:** in Code.gs set `ACCESS_KEY` to a long random secret (e.g. 30+ random characters). Deploy as a NEW web app deployment
   (Deploy > New deployment, Execute as: Me, Access: Anyone) and copy the new `/exec` URL. The old URL was visible in the old index.html, so retire it
   (Deploy > Manage deployments > archive the old one).
2. **Netlify:** deploy this folder (Git or drag-and-drop with the Netlify CLI; the function needs a build, so plain "drop a folder" on the web UI won't include functions).
3. **Netlify > Site configuration > Environment variables:**
   - `APPS_SCRIPT_URL` = the new /exec URL
   - `SCRIPT_KEY` = the same secret as `ACCESS_KEY` in Code.gs
   - `LOGIN_KEY` = the password staff type on the login screen (optional; defaults to SCRIPT_KEY)
4. Redeploy the site once after saving the variables.

Staff only ever know `LOGIN_KEY`. The Apps Script URL and `SCRIPT_KEY` never reach the browser.
