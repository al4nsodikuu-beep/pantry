import base64
import copy
import json
from datetime import datetime, timedelta, timezone
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from backend.billing import BillingService, BillingError, Store
from backend.app import create_app

TOKEN='opaque-google-play-purchase-token-one'
NOW=datetime(2026,9,20,12,tzinfo=timezone.utc)

class FakePlay:
    def __init__(self): self.purchases={};self.acknowledged=[];self.ack_failure=False;self.unavailable=False;self.reads=0
    def get(self,token):
        self.reads+=1
        if self.unavailable: raise BillingError('verification_unavailable',503)
        if token not in self.purchases: raise BillingError('purchase_not_found')
        return copy.deepcopy(self.purchases[token])
    def acknowledge(self,product,token):
        if self.ack_failure: raise BillingError('acknowledgement_pending',503)
        self.acknowledged.append((product,token))
        self.purchases[token]['acknowledgementState']='ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'

@pytest.fixture
def service(tmp_path):
    play=FakePlay(); now=[NOW]
    result=BillingService(Store(tmp_path/'billing.sqlite3'),play,package='com.example.pantry',encryption_key=Fernet.generate_key(),binding_secret=b'x'*32,clock=lambda:now[0])
    result.test_clock=now
    result.context('alice');result.context('bob')
    return result

def purchase(service,token=TOKEN,uid='alice',state='ACTIVE',days=30,ack=False,product='premium',plan='monthly',linked=None):
    item={'subscriptionState':'SUBSCRIPTION_STATE_'+state,'startTime':NOW.isoformat(),'acknowledgementState':'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' if ack else 'ACKNOWLEDGEMENT_STATE_PENDING','externalAccountIdentifiers':{'obfuscatedExternalAccountId':service.account_id(uid)},'lineItems':[{'productId':product,'offerDetails':{'basePlanId':plan},'expiryTime':(NOW+timedelta(days=days)).isoformat(),'autoRenewingPlan':{'autoRenewEnabled':state!='CANCELED'}}]}
    if linked:item['linkedPurchaseToken']=linked
    service.play.purchases[token]=item
    return item

def test_new_purchase_acknowledged_and_fields_encrypted(service):
    purchase(service)
    result=service.verify('alice',TOKEN)
    assert result['active'] and result['entitlement']=='premium'
    assert service.play.acknowledged==[('premium',TOKEN)]
    assert 'purchase_token' not in result and 'user_id' not in result
    with service.store.connect() as db:
        row=db.execute('SELECT * FROM subscriptions').fetchone()
        assert row['user_id']=='alice' and row['platform']=='google_play'
        assert row['subscription_status']=='ACTIVE' and row['auto_renewing']==1
        assert row['purchase_token']!=TOKEN.encode()
        assert service.crypt.decrypt(row['purchase_token']).decode()==TOKEN
        assert db.execute('SELECT entitlement,active FROM entitlements').fetchone()[:]==('premium',1)

@pytest.mark.parametrize('state,days,expected', [('ACTIVE',30,True),('IN_GRACE_PERIOD',1,True),('CANCELED',4,True),('CANCELED',-1,False),('ACTIVE',-1,False),('EXPIRED',30,False),('ON_HOLD',30,False),('PAUSED',30,False),('PENDING',30,False),('PENDING_PURCHASE_CANCELED',30,False),('UNSPECIFIED',30,False)])
def test_status_matrix(service,state,days,expected):
    purchase(service,state=state,days=days)
    result=service.verify('alice',TOKEN)
    assert result['active'] is expected
    if not expected:assert not service.play.acknowledged

def test_cancellation_preserves_paid_through_then_expires(service):
    purchase(service,state='CANCELED',days=1)
    assert service.verify('alice',TOKEN)['active']
    assert not service.entitlement('alice')['auto_renewing']
    service.test_clock[0]=NOW+timedelta(days=1,seconds=1)
    result=service.entitlement('alice')
    assert not result['active'] and result['subscription_status']=='expired'

@pytest.mark.parametrize('state',['EXPIRED','ON_HOLD','PAUSED'])
def test_status_changes_remove_access_on_next_protected_request(service,state):
    purchase(service);service.verify('alice',TOKEN)
    service.play.purchases[TOKEN]['subscriptionState']='SUBSCRIPTION_STATE_'+state
    with pytest.raises(BillingError,match='premium_required'):service.require_premium('alice')
    with service.store.connect() as db:assert db.execute('SELECT active FROM entitlements').fetchone()[0]==0

def test_refund_revoke_rtdn_queries_google_and_is_idempotent(service):
    purchase(service);service.verify('alice',TOKEN)
    service.play.purchases[TOKEN]['subscriptionState']='SUBSCRIPTION_STATE_EXPIRED'
    payload={'packageName':service.package,'voidedPurchaseNotification':{'purchaseToken':TOKEN}}
    assert service.notification('event-1',payload)=={'processed':True}
    reads=service.play.reads
    assert service.notification('event-1',payload)['duplicate']
    assert service.play.reads==reads
    # An old "renewed" notification cannot reinstate a Google-expired subscription.
    assert service.notification('older-renewal',{'packageName':service.package,'subscriptionNotification':{'purchaseToken':TOKEN,'notificationType':2}})['processed']
    assert not service.entitlement('alice')['active']

def test_replay_and_wrong_account_blocked(service):
    purchase(service)
    with pytest.raises(BillingError,match='purchase_account_mismatch'):service.verify('bob',TOKEN)
    assert service.verify('alice',TOKEN)['active']
    with pytest.raises(BillingError,match='purchase_belongs_to_another_account'):service.verify('bob',TOKEN)
    assert not service.entitlement('bob')['active']

def test_unbound_unknown_tokens_cannot_be_claimed(service):
    p=purchase(service);p.pop('externalAccountIdentifiers')
    with pytest.raises(BillingError,match='purchase_account_mismatch'):service.verify('alice',TOKEN)

@pytest.mark.parametrize('product,plan',[('other','monthly'),('premium','one-time'),('','annual')])
def test_product_allowlist(service,product,plan):
    purchase(service,product=product,plan=plan)
    with pytest.raises(BillingError,match='unexpected_subscription_product'):service.verify('alice',TOKEN)

def test_annual_and_renewal_updates_expiry(service):
    purchase(service,plan='annual',days=365)
    first=service.verify('alice',TOKEN)
    assert first['base_plan_id']=='annual'
    service.play.purchases[TOKEN]['lineItems'][0]['expiryTime']=(NOW+timedelta(days=730)).isoformat()
    assert service.entitlement('alice')['subscription_expiry']>first['subscription_expiry']

def test_ack_failure_persists_for_retry_but_never_unlocks(service):
    purchase(service);service.play.ack_failure=True
    result=service.verify('alice',TOKEN)
    assert not result['active'] and result['subscription_status']=='verification_pending'
    service.play.ack_failure=False
    assert service.reconcile()=={'checked_users':1,'failed_users':0}
    assert service.entitlement('alice')['active']

def test_network_failure_never_uses_cached_active_boolean(service):
    purchase(service);service.verify('alice',TOKEN);service.play.unavailable=True
    with pytest.raises(BillingError,match='verification_unavailable'):service.require_premium('alice')
    assert service.reconcile()['failed_users']==1

def test_linked_replacement_suppresses_old_token_permanently(service):
    purchase(service,days=300);service.verify('alice',TOKEN)
    newer='replacement-google-token'
    purchase(service,token=newer,days=30,plan='annual',linked=TOKEN)
    assert service.verify('alice',newer)['active']
    service.play.purchases[newer]['subscriptionState']='SUBSCRIPTION_STATE_EXPIRED'
    assert not service.entitlement('alice')['active']
    # Delayed old-token update must never grant access back to the replaced token.
    service.notification('late-old',{'packageName':service.package,'subscriptionNotification':{'purchaseToken':TOKEN}})
    assert not service.entitlement('alice')['active']

def test_missing_google_token_removes_access(service):
    purchase(service);service.verify('alice',TOKEN);del service.play.purchases[TOKEN]
    assert service.entitlement('alice')['subscription_status']=='invalid'
    with pytest.raises(BillingError,match='premium_required'):service.require_premium('alice')

def test_http_auth_and_no_trusted_user_or_frontend_entitlement(service):
    client=TestClient(create_app(service))
    assert client.get('/api/entitlements/premium').status_code==401
    assert client.post('/api/billing/google-play/verify',json={'purchase_token':TOKEN}).status_code==401
    assert client.post('/api/premium/meal-plan',json={}).status_code==401
    assert client.post('/api/billing/google-play/rtdn',json={}).status_code in (401,503)
    client=TestClient(create_app(service,account_auth=lambda:'alice'))
    assert client.post('/api/billing/google-play/verify',json={'purchase_token':TOKEN,'user_id':'bob','active':True}).status_code==422
    assert client.post('/api/premium/meal-plan',json={}).status_code==403
    purchase(service);assert client.post('/api/billing/google-play/verify',json={'purchase_token':TOKEN}).json()['active']
    plan=client.post('/api/premium/meal-plan',json={'diet':'vegetarian','household':4})
    assert plan.status_code==200 and len(plan.json()['recipe_ids'])==7
    assert 'beef-pasta' not in plan.json()['recipe_ids']
    assert client.post('/api/premium/chef',json={'question':'Hello'}).json()['error']=='ai_service_not_connected'
    service.play.purchases[TOKEN]['subscriptionState']='SUBSCRIPTION_STATE_EXPIRED'
    assert client.post('/api/premium/meal-plan',json={}).status_code==403

def test_notification_auth_precedes_side_effects(service):
    purchase(service);service.verify('alice',TOKEN)
    def reject(*args):raise BillingError('invalid_notification_identity',401)
    client=TestClient(create_app(service,account_auth=lambda:'alice',machine_auth=reject))
    payload={'message':{'messageId':'x','data':base64.b64encode(json.dumps({'packageName':service.package,'subscriptionNotification':{'purchaseToken':TOKEN}}).encode()).decode()}}
    before=service.play.reads
    assert client.post('/api/billing/google-play/rtdn',json=payload).status_code==401
    assert client.post('/internal/reconcile').status_code==401
    assert service.play.reads==before
    client=TestClient(create_app(service,account_auth=lambda:'alice',machine_auth=lambda *args:None))
    assert client.post('/api/billing/google-play/rtdn',json=payload).status_code==200
    assert client.post('/api/billing/google-play/rtdn',json=payload).json()['duplicate']

def test_database_entitlement_boolean_alone_cannot_grant(service):
    service.entitlement('alice')
    with service.store.transaction() as db:
        db.execute("UPDATE entitlements SET active=1,expires_at=? WHERE user_id='alice'",((NOW+timedelta(days=365)).isoformat(),))
    with pytest.raises(BillingError,match='premium_required'):service.require_premium('alice')

def test_bound_request_size_rejects_oversized_and_malformed(service):
    client=TestClient(create_app(service,account_auth=lambda:'alice'))
    assert client.post('/api/billing/google-play/verify',content='x'*65537).status_code==413
    assert client.post('/api/billing/google-play/verify',content='{}',headers={'Content-Length':'invalid'}).status_code==400
