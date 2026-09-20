# Pantry

A private mobile-first kitchen recipe prototype with the Pantry name and leaf logo, dark navy surfaces, emerald actions and the supplied CookAI interface reference.

## Current implementation

- Ingredient photo selection with explicitly simulated recognition, editable detection review and manual entry.
- Eight curated sample recipes with ingredient matching, filters, details, serving scaling, saved recipes and cooking mode.
- Cooking timer, shopping checklist, ingredient-date reminders and profile preferences.
- English, Afrikaans and Portuguese interface selection. Sample recipes remain English.
- **CookAI Premium** screen with monthly N$49 and annual N$399 planned prices; actual Android subscription prices come from Google Play at runtime.
- Native Android Google Play Billing integration, Firebase account authentication, a verification backend, encrypted subscription database and the `premium` entitlement.
- Server-enforced Premium access, restore and lifecycle states. No local Premium activation or demo checkout.

**The published Sites app is a private static preview. Live Google Play purchases and account verification require your Play Console/Firebase configuration and a separately deployed backend.** The AI services are not yet connected. Purchases stay disabled until ready; the web preview cannot charge anyone.

See [subscription architecture, setup and validation](docs/SUBSCRIPTIONS.md) for the database fields, account binding, lifecycle rules, Android build and remaining launch requirements.

## Run and test

`npm start` serves `public/` on port 3000. `npm run build` validates JavaScript and copies the static output to `dist/` for the existing owner-private Sites project. Android bundles only `public/`; server credentials and source are never web assets.

`node smoke-test.cjs` validates the free recipe flow, safe Premium behavior, translations and responsive widths. `node billing-ui-test.cjs` exercises purchase states with a test-only native transport. Install test dependencies with `npm ci` and `npx playwright install chromium`; set `CHROMIUM_PATH` to use an existing browser.

Install `backend/requirements-dev.txt` into a Python environment and run `python -m pytest backend/tests -q` for server authorization/lifecycle tests. The setup document includes Android build instructions and the required live Play license-test matrix.

Saved pantry, recipe and language preferences use local browser storage. Subscription ownership and access do not. The sample meal planner is served only by the backend after a fresh Google verification. AI endpoints remain safely unavailable until their provider is implemented.

## Assets

Self-hosted DM Sans and DM Serif Display fonts from Google Fonts, distributed under the SIL Open Font License. Food photographs from Unsplash Images, accessed September 2026:

- `pasta.jpg`: photo-1551183053-bf91a1d81141
- `green-pasta.jpg`: photo-1473093295043-cdd812d0e601
- `tomato-pasta.jpg`: photo-1598866594230-a7c12756260f
- `rice.jpg`: photo-1512058564366-18510be2db19
- `salad.jpg`: photo-1547592180-85f173990554
- `ingredients.jpg`: photo-1490645935967-10de6ba17061

All static assets are served locally. The Android app uses Google Play, Firebase Authentication and the configured verification API; the browser preview makes no third-party service requests.
