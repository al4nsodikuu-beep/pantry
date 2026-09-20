"""Only this server module can write subscription or entitlement records."""
from __future__ import annotations
import hashlib
import hmac
import sqlite3
from contextlib import contextmanager, closing
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from cryptography.fernet import Fernet

class BillingError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code, self.status = code, status

def utcnow():
    return datetime.now(timezone.utc)

def parse_time(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (TypeError, ValueError, AttributeError):
        return None

ALLOWED_STATES = {'ACTIVE', 'IN_GRACE_PERIOD', 'CANCELED'}

class Store:
    """A single-instance persistent SQLite deployment. No browser DB access."""
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as db:
            db.executescript(Path(__file__).with_name('schema.sql').read_text())
            db.execute('PRAGMA journal_mode=WAL')

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            # Serialize state refreshes, ownership claims and linked-token revocation.
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

class GooglePlay:
    def __init__(self, package):
        import google.auth
        from google.auth.transport.requests import AuthorizedSession
        credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/androidpublisher'])
        self.session = AuthorizedSession(credentials)
        self.root = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + quote(package, safe='')

    def get(self, token):
        try:
            response = self.session.get(self.root + '/purchases/subscriptionsv2/tokens/' + quote(token, safe=''), timeout=15)
        except Exception:
            raise BillingError('verification_unavailable', 503) from None
        if response.status_code in (404, 410):
            raise BillingError('purchase_not_found', 400)
        if not response.ok:
            # Do not log Google responses, URLs, headers, tokens or credentials.
            raise BillingError('verification_unavailable', 503)
        try:
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except Exception:
            raise BillingError('verification_unavailable', 503) from None

    def acknowledge(self, product_id, token):
        try:
            response = self.session.post(self.root + '/purchases/subscriptions/' + quote(product_id, safe='') + '/tokens/' + quote(token, safe='') + ':acknowledge', json={}, timeout=15)
        except Exception:
            raise BillingError('acknowledgement_pending', 503) from None
        if not response.ok:
            raise BillingError('acknowledgement_pending', 503)

class BillingService:
    def __init__(self, store, play, *, package, encryption_key, binding_secret, product='premium', plans=('monthly','annual'), clock=utcnow):
        self.store, self.play, self.package, self.product = store, play, package, product
        self.crypt = Fernet(encryption_key)
        if len(binding_secret) < 32:
            raise ValueError('BILLING_BINDING_SECRET must be at least 32 bytes')
        self.secret, self.plans, self.clock = binding_secret, set(plans), clock

    def account_id(self, uid):
        return hmac.new(self.secret, ('account:' + uid).encode(), hashlib.sha256).hexdigest()

    def token_hash(self, token):
        return hmac.new(self.secret, ('token:' + token).encode(), hashlib.sha256).hexdigest()

    def context(self, uid):
        with self.store.transaction() as db:
            db.execute('INSERT OR IGNORE INTO accounts VALUES (?,?,?)', (uid, self.account_id(uid), self.clock().isoformat()))
        return {'entitlement':'premium', 'product_id':self.product, 'base_plans':sorted(self.plans), 'obfuscated_account_id':self.account_id(uid), 'package_name':self.package}

    def _refresh(self, db, token, uid=None):
        token_hash = self.token_hash(token)
        existing = db.execute('SELECT * FROM subscriptions WHERE token_hash=?', (token_hash,)).fetchone()
        if existing and uid and existing['user_id'] != uid:
            raise BillingError('purchase_belongs_to_another_account', 409)
        try:
            purchase = self.play.get(token)
        except BillingError as exc:
            if existing and exc.code == 'purchase_not_found':
                db.execute("UPDATE subscriptions SET subscription_status='INVALID',last_verified_at=? WHERE token_hash=?", (self.clock().isoformat(), token_hash))
                return existing['user_id']
            raise
        linked = purchase.get('linkedPurchaseToken')
        linked_row = db.execute('SELECT * FROM subscriptions WHERE token_hash=?', (self.token_hash(linked),)).fetchone() if linked else None
        bound_id = purchase.get('externalAccountIdentifiers', {}).get('obfuscatedExternalAccountId')
        account = db.execute('SELECT user_id FROM accounts WHERE play_account_id=?', (bound_id,)).fetchone() if bound_id else None
        owner = existing['user_id'] if existing else (account['user_id'] if account else (linked_row['user_id'] if linked_row else None))
        if not owner or (uid and owner != uid) or (account and account['user_id'] != owner) or (linked_row and linked_row['user_id'] != owner):
            raise BillingError('purchase_account_mismatch', 403)
        if bound_id and not hmac.compare_digest(bound_id, self.account_id(owner)):
            raise BillingError('purchase_account_mismatch', 403)
        # Unknown tokens without a verified account binding or known linked token cannot be claimed.
        lines = [line for line in purchase.get('lineItems', []) if line.get('productId') == self.product and line.get('offerDetails', {}).get('basePlanId') in self.plans]
        if not lines:
            raise BillingError('unexpected_subscription_product', 400)
        line = max(lines, key=lambda x: parse_time(x.get('expiryTime')) or datetime.min.replace(tzinfo=timezone.utc))
        status = purchase.get('subscriptionState', '').removeprefix('SUBSCRIPTION_STATE_')
        expiry = parse_time(line.get('expiryTime'))
        acknowledged = purchase.get('acknowledgementState') == 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
        now = self.clock()
        db.execute('''INSERT INTO subscriptions
          (token_hash,user_id,subscription_status,product_id,base_plan_id,purchase_token,subscription_start,subscription_expiry,auto_renewing,platform,acknowledged,last_verified_at)
          VALUES(?,?,?,?,?,?,?,?,?,'google_play',?,?) ON CONFLICT(token_hash) DO UPDATE SET
          subscription_status=excluded.subscription_status,base_plan_id=excluded.base_plan_id,
          subscription_start=excluded.subscription_start,subscription_expiry=excluded.subscription_expiry,
          auto_renewing=excluded.auto_renewing,acknowledged=excluded.acknowledged,last_verified_at=excluded.last_verified_at''',
          (token_hash,owner,status,self.product,line['offerDetails']['basePlanId'],self.crypt.encrypt(token.encode()),purchase.get('startTime'),expiry.isoformat() if expiry else None,int(line.get('autoRenewingPlan',{}).get('autoRenewEnabled',False)),int(acknowledged),now.isoformat()))
        if linked_row:
            db.execute('UPDATE subscriptions SET replaced_by_hash=? WHERE token_hash=?', (token_hash, linked_row['token_hash']))
        # Acknowledgement is retried by RTDN, restore and reconciliation. No pending payment is acknowledged.
        if not acknowledged and status in ALLOWED_STATES and expiry and expiry > now:
            try:
                self.play.acknowledge(self.product, token)
                db.execute('UPDATE subscriptions SET acknowledged=1 WHERE token_hash=?', (token_hash,))
            except BillingError:
                # Persist the encrypted token for an automatic retry; remain locked meanwhile.
                pass
        return owner

    def _entitlement(self, db, uid):
        rows = db.execute('SELECT * FROM subscriptions WHERE user_id=? ORDER BY last_verified_at DESC', (uid,)).fetchall()
        now = self.clock()
        eligible = [r for r in rows if r['subscription_status'] in ALLOWED_STATES and r['acknowledged'] and not r['replaced_by_hash'] and (parse_time(r['subscription_expiry']) or now) > now]
        current = [r for r in rows if not r['replaced_by_hash']]
        chosen = max(eligible, key=lambda r:r['subscription_expiry']) if eligible else (current[0] if current else None)
        active = bool(eligible)
        expiry = chosen['subscription_expiry'] if chosen else None
        db.execute('''INSERT INTO entitlements VALUES (?,'premium',?,?,?)
           ON CONFLICT(user_id,entitlement) DO UPDATE SET active=excluded.active,expires_at=excluded.expires_at,verified_at=excluded.verified_at''', (uid,int(active),expiry,now.isoformat()))
        status = chosen['subscription_status'].lower() if chosen else 'none'
        if chosen and status in {'active','canceled','in_grace_period'} and (parse_time(expiry) or now) <= now:
            status = 'expired'
        if chosen and not chosen['acknowledged'] and status in {'active','canceled','in_grace_period'}:
            status = 'verification_pending'
        return {'entitlement':'premium','active':active,'subscription_status':status,'product_id':chosen['product_id'] if chosen else None,'base_plan_id':chosen['base_plan_id'] if chosen else None,'subscription_start':chosen['subscription_start'] if chosen else None,'subscription_expiry':expiry,'auto_renewing':bool(chosen['auto_renewing']) if chosen else False,'platform':'google_play','verified_at':now.isoformat(),'manage_url':'https://play.google.com/store/account/subscriptions?sku='+quote(self.product,safe='')+'&package='+quote(self.package,safe='')}

    def verify(self, uid, token):
        if not isinstance(token,str) or not 10 <= len(token) <= 4096:
            raise BillingError('invalid_purchase_token')
        self.context(uid)
        with self.store.transaction() as db:
            self._refresh(db,token,uid)
            return self._entitlement(db,uid)

    def entitlement(self, uid):
        self.context(uid)
        with self.store.transaction() as db:
            rows = db.execute('SELECT purchase_token FROM subscriptions WHERE user_id=? AND replaced_by_hash IS NULL', (uid,)).fetchall()
            # A stale local/DB boolean is never sufficient. Recheck Google before a premium operation.
            for row in rows:
                self._refresh(db,self.crypt.decrypt(row['purchase_token']).decode(),uid)
            return self._entitlement(db,uid)

    def require_premium(self, uid):
        verified = self.entitlement(uid)
        if not verified['active']:
            raise BillingError('premium_required',403)
        return verified

    def notification(self, message_id, payload):
        if payload.get('packageName') != self.package:
            raise BillingError('notification_package_mismatch',400)
        if payload.get('testNotification'):
            return {'processed':True,'test':True}
        notification = payload.get('subscriptionNotification') or payload.get('voidedPurchaseNotification') or {}
        token = notification.get('purchaseToken')
        if not token:
            return {'processed':True,'ignored':True}
        with self.store.transaction() as db:
            if db.execute('SELECT 1 FROM processed_notifications WHERE message_id=?',(message_id,)).fetchone():
                return {'processed':True,'duplicate':True}
            # Notification types and event times do NOT directly grant or revoke access.
            uid = self._refresh(db,token)
            self._entitlement(db,uid)
            db.execute('INSERT INTO processed_notifications VALUES (?,?)',(message_id,self.clock().isoformat()))
        return {'processed':True}

    def reconcile(self):
        with closing(self.store.connect()) as db:
            users = [r[0] for r in db.execute('SELECT DISTINCT user_id FROM subscriptions WHERE replaced_by_hash IS NULL')]
        failed = 0
        for uid in users:
            try:
                self.entitlement(uid)
            except Exception:
                failed += 1
        return {'checked_users':len(users),'failed_users':failed}
