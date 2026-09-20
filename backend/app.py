"""Run behind HTTPS: uvicorn backend.app:app --host 0.0.0.0 --port 8080.

Missing configuration fails closed. Authentication can only be replaced through
the Python factory in unit tests, never by a request header or environment flag.
"""
import base64
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal
from fastapi import FastAPI, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from .billing import Store, GooglePlay, BillingService, BillingError

@lru_cache
def firebase_app():
    import firebase_admin
    project = os.environ.get('FIREBASE_PROJECT_ID')
    if not project:
        raise BillingError('account_service_not_configured',503)
    return firebase_admin.initialize_app(options={'projectId':project})

def bearer(authorization):
    if not authorization or not authorization.startswith('Bearer '):
        raise BillingError('sign_in_required',401)
    return authorization[7:]

def authenticate(authorization: str | None = Header(default=None)):
    from firebase_admin import auth
    token = bearer(authorization)
    try:
        claims = auth.verify_id_token(token, app=firebase_app(), check_revoked=True)
    except BillingError:
        raise
    except Exception:
        raise BillingError('invalid_account_session',401)
    if not claims.get('email_verified'):
        raise BillingError('verify_your_email',403)
    return claims['uid']

def verify_machine(authorization, audience, email):
    from google.auth.transport.requests import Request as GoogleRequest
    from google.oauth2.id_token import verify_oauth2_token
    if not audience or not email:
        raise BillingError('notification_service_not_configured',503)
    try:
        claims = verify_oauth2_token(bearer(authorization),GoogleRequest(),audience=audience)
        if claims.get('email') != email or claims.get('email_verified') is not True:
            raise ValueError('wrong_identity')
    except Exception:
        raise BillingError('invalid_notification_identity',401)

@lru_cache
def configured_service():
    needed = ('PLAY_PACKAGE_NAME','BILLING_ENCRYPTION_KEY','BILLING_BINDING_SECRET','FIREBASE_PROJECT_ID','BILLING_DB_PATH')
    if any(not os.environ.get(key) for key in needed):
        raise BillingError('billing_not_configured',503)
    package = os.environ['PLAY_PACKAGE_NAME']
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+',package):
        raise BillingError('invalid_server_configuration',503)
    try:
        return BillingService(Store(os.environ['BILLING_DB_PATH']),GooglePlay(package),package=package,encryption_key=os.environ['BILLING_ENCRYPTION_KEY'].encode(),binding_secret=os.environ['BILLING_BINDING_SECRET'].encode(),product=os.environ.get('PLAY_PRODUCT_ID','premium'),plans=(os.environ.get('PLAY_MONTHLY_PLAN','monthly'),os.environ.get('PLAY_ANNUAL_PLAN','annual')))
    except Exception:
        raise BillingError('billing_not_configured',503)

class VerifyBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    purchase_token: str = Field(min_length=10,max_length=4096)

class PlanBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    diet: Literal['any','vegetarian'] = 'any'
    household: int = Field(default=2,ge=1,le=8)
    exclude_id: str | None = Field(default=None,max_length=80)

class AIBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    recipe_id: str | None = Field(default=None,max_length=80)
    question: str | None = Field(default=None,max_length=500)

def create_app(service=None, account_auth=authenticate, machine_auth=verify_machine):
    app = FastAPI(title='Pantry verified subscriptions',docs_url=None,redoc_url=None)
    def get_service():
        return service if service is not None else configured_service()

    @app.exception_handler(BillingError)
    async def billing_error(request,exc):
        return JSONResponse({'error':exc.code},status_code=exc.status,headers={'Cache-Control':'no-store'})

    @app.middleware('http')
    async def headers(request,call_next):
        try:
            size = int(request.headers.get('content-length','0') or '0')
        except ValueError:
            return JSONResponse({'error':'invalid_request'},status_code=400)
        if size > 65536:
            return JSONResponse({'error':'request_too_large'},status_code=413)
        # Also bound bodies sent without Content-Length (for example, chunked requests).
        if request.method in {'POST','PUT','PATCH'}:
            total = 0
            chunks = []
            async for chunk in request.stream():
                total += len(chunk)
                if total > 65536:
                    return JSONResponse({'error':'request_too_large'},status_code=413)
                chunks.append(chunk)
            request._body = b''.join(chunks)
        response = await call_next(request)
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        return response

    @app.get('/health')
    def health():
        return {'service':'pantry-billing','billing_enabled':os.environ.get('BILLING_ENABLED')=='true'}

    @app.get('/api/billing/context')
    def context(uid=Depends(account_auth)):
        data = get_service().context(uid)
        data['billing_enabled'] = os.environ.get('BILLING_ENABLED')=='true'
        return data

    @app.get('/api/entitlements/premium')
    def entitlement(uid=Depends(account_auth)):
        return get_service().entitlement(uid)

    @app.post('/api/billing/google-play/verify')
    def verify(body:VerifyBody,uid=Depends(account_auth)):
        return get_service().verify(uid,body.purchase_token)

    @app.post('/api/billing/google-play/rtdn')
    def rtdn(body:dict,authorization:str|None=Header(default=None)):
        machine_auth(authorization,os.environ.get('PUBSUB_PUSH_AUDIENCE'),os.environ.get('PUBSUB_PUSH_SERVICE_ACCOUNT'))
        try:
            message=body['message']
            message_id=message['messageId']
            payload=json.loads(base64.b64decode(message['data'],validate=True))
            if not isinstance(message_id,str) or not message_id or len(message_id)>256:
                raise ValueError()
        except Exception:
            raise BillingError('invalid_notification')
        return get_service().notification(message_id,payload)

    @app.post('/internal/reconcile')
    def reconcile(authorization:str|None=Header(default=None)):
        machine_auth(authorization,os.environ.get('SCHEDULER_AUDIENCE'),os.environ.get('SCHEDULER_SERVICE_ACCOUNT'))
        result=get_service().reconcile()
        return JSONResponse(result,status_code=503 if result['failed_users'] else 200)

    @app.post('/api/premium/meal-plan')
    def meal_plan(body:PlanBody,uid=Depends(account_auth)):
        get_service().require_premium(uid)
        recipes=json.loads(Path(__file__).with_name('recipes.json').read_text())
        pool=[r for r in recipes if (body.diet!='vegetarian' or r['vegetarian']) and r['id']!=body.exclude_id]
        return {'recipe_ids':[pool[i%len(pool)]['id'] for i in range(7)],'household':body.household,'sample_content':True}

    @app.post('/api/premium/{feature}')
    def ai_feature(feature:str,body:AIBody,uid=Depends(account_auth)):
        if feature not in {'chef','scans','recipes','substitutions','nutrition'}:
            raise BillingError('unknown_feature',404)
        get_service().require_premium(uid)
        # No fabricated AI response or client bypass. Connect a real server-side provider here.
        raise BillingError('ai_service_not_connected',503)

    return app

app=create_app()
