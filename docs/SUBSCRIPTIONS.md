# Pantry Google Play subscriptions

The code implements a real Android Billing Library integration and a separate verification service. The private Sites publication remains a static web prototype. **No Play Console product, Firebase project, live backend, service identity, or real purchase has been provisioned by this repository.** Purchases are disabled until configuration and license testing are complete. There is no simulated purchase button and no local Premium unlock.

## Components

| Component | Responsibility |
| --- | --- |
| `public/premium.js` | Premium screen, runtime product prices, selection, loading, purchase, pending, error, canceled, expired, restore, management states |
| `android/…/MainActivity.kt` | Local bundled web app, origin-restricted message bridge, Firebase account sign-in, verified email |
| `android/…/PlaySubscriptions.kt` | Billing Library 9.1.0, ProductDetails queries, offer selection, purchase sheet, restore and foreground refresh |
| `android/…/BillingApi.kt` | HTTPS requests with the current Firebase ID token; no token passed to JavaScript |
| `backend/billing.py` | Google verification, encrypted tokens, account ownership, acknowledgement, lifecycle reconciliation |
| `backend/app.py` | Authenticated API and protected Premium operations |
| `backend/schema.sql` | Durable account, subscription and entitlement records |
| `public/languages.js` | English, Afrikaans and Portuguese interface selection, persisted per device |

```mermaid
sequenceDiagram
    participant App as Android app
    participant Play as Google Play
    participant API as Verification API
    participant DB as Subscription database
    App->>API: Verified account token; request billing context
    API-->>App: Product, plans, obfuscated account ID
    App->>Play: Query ProductDetails and launch selected offer
    Play-->>App: Purchase state and purchase token
    App->>API: Submit purchased token with account authentication
    API->>Play: Read subscriptionsv2; check owner, product, status and expiry
    API->>Play: Acknowledge completed purchase
    API->>DB: Save verified subscription and premium entitlement
    API-->>App: Safe entitlement response
    App->>API: Request Premium feature
    API->>Play: Recheck subscription
    API-->>App: Allow feature only while verified active
```

The browser cannot carry out a Google Play purchase. It shows the requested proposed prices, `N$49/month` and `N$399/year`, and explains that Android is required. Inside the configured Android app, prices come from Google's `ProductDetails` recurring pricing phase. Changing a plan's price in Play Console changes subsequent product queries without an app update. The purchase sheet is the final source of the charged price. Existing subscriber price cohorts follow Google's price-change rules.

## Play Console setup

Use the real Android package/application ID from your Play Console app. `com.pantry.app` is only the source project's default and has not been registered or confirmed as yours.

Create this auto-renewing subscription and activate both base plans for the intended countries:

| Setting | Value |
| --- | --- |
| Subscription product ID | `premium` |
| Backend entitlement | `premium` |
| Monthly base plan ID | `monthly` |
| Monthly billing period | `P1M` |
| Requested monthly price | N$49/month |
| Annual base plan ID | `annual` |
| Annual billing period | `P1Y` |
| Requested annual price | N$399/year |

Confirm available buyer currencies in your Console. The N$ prices are requested targets; do not label another currency as NAD or hardcode an exchange rate. Where Google does not support a local buyer currency, choose a supported price in Console and let ProductDetails display the actual localized amount. This integration uses the ordinary recurring base plan (`offerId == null`), not trials, prepaid plans or installment commitments. New subscribers can select either plan. Existing subscribers use Manage Subscription; in-app plan replacement/proration is not implemented.

Add an internal test track and Google Play license testers. Register the exact signing certificate and package with Firebase. Upload a signed build to your test track; do not publish it publicly without approval. Product availability and testing require your Console configuration. A locally built debug APK alone does not validate real billing.

## Account setup

Create/configure Firebase Authentication for the Android package, enable email/password sign-in, and configure verification emails. The Android app offers sign-in and account creation; the backend rejects unverified emails and revoked sessions. Firebase's API key, project ID and app ID are public app identifiers, not service-account credentials. Restrict that key appropriately for your application.

Set these **public** Gradle properties through your local Gradle configuration or CI:

```properties
PLAY_PACKAGE_NAME=your.registered.android.package
BILLING_API_URL=https://your-verification-server.example
FIREBASE_PROJECT_ID=your-firebase-project
FIREBASE_APP_ID=your-firebase-android-app-id
FIREBASE_API_KEY=your-firebase-public-api-key
```

Never put a Play service-account JSON file, private key, token encryption key or HMAC secret in these properties, Android resources, JavaScript or the packaged assets. Only `public/` is bundled in the app. The Firebase JWT remains in native code and goes only to the configured HTTPS backend.

The app's language menu translates core navigation, ingredient capture controls, profile settings and the Premium flow. Sample recipe content and the native sign-in dialog remain English; the profile explicitly notes the sample-recipe limitation.

## Verification server deployment

Use a single server/container with a persistent mounted `/data` volume, TLS and reliable backups. SQLite is intentionally a single-instance design; do not deploy this database onto an ephemeral filesystem or run multiple replicas. For multi-instance scale, move the schema to a transactional shared database and retain uniqueness/ownership checks and serialized per-account reconciliation.

1. Build from the repository root: `docker build -f backend/Dockerfile -t pantry-billing .`
2. Configure the environment described in `backend/.env.example`. Never commit the populated environment file.
3. Inject secrets with your host's secret manager. Generate the Fernet key with `Fernet.generate_key()` and use at least 32 random bytes for the separate HMAC binding secret. Keep both stable and backed up. Key rotation requires a migration; changing the HMAC secret would change account and token identities.
4. Prefer an attached Google service identity / Application Default Credentials. Enable the Google Play Android Developer API. Give this server identity access to the target Play app and the permissions required to read purchases/subscriptions and acknowledge/manage subscriptions. Give it the Firebase Authentication permissions needed to verify revoked tokens. Credentials stay on the server.
5. Mount persistent storage owned by container UID 10001 at `/data`. Listen on port 8080 behind your HTTPS ingress. Apply request throttling and body limits at the ingress; the app also bounds bodies to 64 KiB. Do not log request bodies, authorization headers, Google token URLs or plaintext purchase tokens.
6. Configure RTDN and the scheduled reconcile endpoint below.
7. Keep `BILLING_ENABLED=false` while configuring. Enable it only for the configured test environment after testing, and for the production environment once the advertised services are ready.

The Docker image runs as a non-root user with one Uvicorn worker and access logging disabled. `GET /health` reports service availability, not a successful Google credential check.

### RTDN and recovery

Create a Google Pub/Sub topic for Play Real-time Developer Notifications. Grant Google's Play notification publisher permission to publish to that topic and configure the topic in Play Console. Use an authenticated push subscription to:

`POST https://<backend>/api/billing/google-play/rtdn`

Set `PUBSUB_PUSH_AUDIENCE` to the exact audience configured for the push token and `PUBSUB_PUSH_SERVICE_ACCOUNT` to its dedicated service-account email. The backend verifies Google's signed OIDC JWT, audience, email and `email_verified`. Configure the Pub/Sub service agent's ability to mint that identity token. Set the push acknowledgement deadline to at least 60 seconds. Configure retry/backoff and a dead-letter queue; monitor delivery and verification failures.

Create a scheduler job every five minutes targeting `POST /internal/reconcile`. Configure its OIDC audience and dedicated identity using `SCHEDULER_AUDIENCE` and `SCHEDULER_SERVICE_ACCOUNT`. Both machine endpoints reject unauthenticated requests. Reconciliation retries unacknowledged purchases and refreshes every account with a known current token. A failed refresh returns an error for monitoring/retry. Premium API calls also recheck Google directly, so a missed notification cannot authorize a stale cached entitlement.

RTDN notification types and event timestamps are hints, not grants. Each accepted notification re-fetches current Google status. Duplicate message IDs are ignored only after successful processing. Out-of-order notifications therefore cannot reinstate a subscription that Google now reports expired. Unknown or invalid events are not allowed to attach a token to an arbitrary user.

## Database and access rules

`subscriptions` contains all requested fields:

| Field | Source / treatment |
| --- | --- |
| `user_id` | Verified Firebase account, bound to Play's obfuscated account ID |
| `subscription_status` | Google's verified subscription state |
| `product_id` | Server-allowlisted Play product |
| `purchase_token` | Authenticated Fernet encryption at rest; never returned in an entitlement response |
| `subscription_start` | Verified Google start time |
| `subscription_expiry` | Verified Google line-item expiry |
| `auto_renewing` | Verified Google auto-renewing status |
| `platform` | `google_play` |

Additional fields hold base plan, acknowledgement, token uniqueness hash, replacement linkage and last verification time. The `entitlements` table is keyed by `(user_id, entitlement)` with `entitlement = 'premium'`. Neither table accepts direct browser writes. Credit-card data is neither requested nor stored.

An account's obfuscated Play ID is a stable server-generated HMAC of its verified user ID. The native purchase flow passes it to Google. A token may belong to only one account. An unknown token without a trusted account binding or a known linked purchase cannot be claimed by a caller. Restoring on a new device requires the original Pantry account and the relevant Google Play account.

| Verified subscription condition | Access |
| --- | --- |
| Active, acknowledged, future expiry | Allowed |
| Grace period, acknowledged, future expiry | Allowed while Google permits it |
| Renewal canceled, acknowledged, future expiry | Allowed until paid-through expiry |
| Pending payment or unacknowledged verification | Locked |
| Expired, paused, on hold, invalid or revoked | Locked |
| Verification service unreachable | Protected request fails closed |
| Replaced linked token | Cannot independently re-grant access |

Cancellation of renewal is different from revocation. A refund with revocation removes access once verified by Google; refund-only actions follow Google's resulting entitlement state. The app does not shorten an already-paid period merely because auto-renewal is disabled.

The cached database `active` field and frontend `active` display are never authorization inputs. Every Premium endpoint calls `require_premium()`, which retrieves Google's status again. Android checks again on foregrounding, on restore, after purchase and every minute while active. The UI also clears access on expiry and failed background verification. There is no offline Premium grant.

## Feature readiness

The weekly meal-plan endpoint returns a verified-access-gated seven-day plan using the current curated sample recipes. AI scans, AI recipe generation, AI Chef, advanced substitutions and nutrition are protected routes that currently return `ai_service_not_connected`. A real server-side provider and service implementation must be connected before selling these benefits. The private prototype's free scan remains explicitly simulated. This change implements the subscription architecture; it does not fabricate live AI functionality.

## Build and verification

Requirements: JDK 17, Android SDK platform 36, build tools 35.0.0. Use the Gradle wrapper in `android/`. Public Firebase/backend values may be left unset for a safe shell build; purchases remain unavailable.

```sh
cd android
./gradlew :app:assembleDebug
```

From the repository root:

```sh
npm run build
node smoke-test.cjs
node billing-ui-test.cjs
python -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
.venv/bin/python -m pytest backend/tests -q
```

Browser tests require Playwright/Chromium; `CHROMIUM_PATH` may specify an installed browser. Test mocks live outside `public/` and are excluded from static deployment and Android assets.

The automated suite covers the core prototype, translations/persistence, dynamic returned prices, purchase success/cancel/error/pending, restore and expiration, and local-storage tampering. Backend tests cover ownership, product allowlists, encrypted tokens, acknowledgement retries, renewal, cancellation grace/expiry, invalid/revoked tokens, refund/revocation notifications, replay, linked-token replacement, out-of-order/duplicate notifications, authentication and fail-closed service access.

Before enabling real sales, complete device tests with Play license accounts: monthly and annual purchase, renewal, pending approval/decline, user cancellation, server outage after payment, process death before acknowledgement, reinstall/restore, wrong Pantry account, cancellation through expiry, grace/on-hold, pause/resume, refund with revocation, duplicate RTDN, and changed Console prices. These cannot be validated against live Play without your configured app and account.

## Official implementation references

- [Google Play Billing integration](https://developer.android.com/google/play/billing/integrate)
- [Server security and account binding](https://developer.android.com/google/play/billing/security)
- [Subscription lifecycle](https://developer.android.com/google/play/billing/lifecycle/subscriptions)
- [SubscriptionPurchaseV2 API](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2)
- [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Authenticated Pub/Sub push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
- [Play price and currency support](https://support.google.com/googleplay/android-developer/answer/1169947)

## Validation performed for this change

- Android `:app:assembleDebug`: **successful**, using JDK 17 and SDK 36. This is a compile/build check, not a live purchase test.
- Backend: **31 automated tests passed**, including database-boolean tampering and authenticated feature enforcement.
- Browser core flow: **19 checks passed**, no JavaScript errors or failed assets, with responsive widths 360/390/768/1440.
- Billing UI: **11 purchase-state and transport checks passed** using mocks located outside the deployed app. These are explicitly not Google Play purchase results.
- Live Google Play/Firebase authentication, production RTDN delivery and license purchases: **not performed**, because account-specific configuration has not been supplied.
