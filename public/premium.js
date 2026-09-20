'use strict';
/* Native is transport only. Every protected service enforces its own verified entitlement. */
window.Premium=(()=>{
 const bridge=window.PantryNative;
 const model={phase:bridge?'loading':'unavailable',busy:false,selected:'annual',catalog:[],context:null,entitlement:null,signedIn:false,message:''};
 const requests=new Map();let sequence=0,loaded=false;
 const t=value=>window.Languages?.t(value)||value;
 const text=value=>escapeHTML(t(value));
 const errorMessages={
  native_required:'Purchases are available in the Android app through Google Play. This private web preview cannot make purchases.',
  billing_not_configured:'Google Play subscriptions are not connected yet. No payment can be taken.',
  billing_disabled:'Subscriptions are not open for purchase yet. No payment can be taken.',
  account_service_not_configured:'Account sign-in is not connected yet.',
  sign_in_required:'Sign in to your Pantry account to continue.',
  invalid_account_session:'Please sign in again to continue.',
  verify_your_email:'Check your inbox and verify your email, then sign in again.',
  purchase_canceled:'Purchase canceled. No new subscription was activated.',
  pending_purchase:'Payment is pending in Google Play. Premium will unlock only after payment is completed and verified.',
  verification_pending:'Your purchase is being verified. Use Restore purchases to check again.',
  premium_required:'An active, verified Premium subscription is required.',
  purchase_belongs_to_another_account:'This purchase belongs to another Pantry account. Sign in with the original account.',
  purchase_account_mismatch:'Sign in with the Pantry account used for this purchase.',
  ai_service_not_connected:'AI services are not connected in this prototype yet.',
  product_unavailable:'This plan is not available from Google Play right now. Please try again.',
  already_subscribed:'You already have a subscription. Use Manage Subscription to make changes.',
  verification_unavailable:'We could not verify your subscription. Access remains locked; please try again.',
  service_unavailable:'The subscription service is unavailable. Please try again.',
  billing_unavailable:'Google Play Billing is unavailable on this device. Please try again.',
  purchase_failed:'The purchase could not be completed. Please try again.',
  no_purchases:'No active subscription was found for this account.',
  request_timeout:'This is taking longer than expected. Use Restore purchases to check your subscription.'
 };
 function errorText(error){return t(errorMessages[error?.code||error?.message]||errorMessages.service_unavailable);}
 function request(action,payload={}){
  if(!bridge)return Promise.reject(Object.assign(new Error('native_required'),{code:'native_required'}));
  return new Promise((resolve,reject)=>{const id=String(++sequence);const timeout=setTimeout(()=>{requests.delete(id);reject(Object.assign(new Error('request_timeout'),{code:'request_timeout'}));},120000);requests.set(id,{resolve,reject,timeout});bridge.postMessage(JSON.stringify({id,action,payload}));});
 }
 function accept(data){if(typeof data==='string'){try{data=JSON.parse(data);}catch{return;}}const pending=requests.get(data?.id);if(!pending)return;requests.delete(data.id);clearTimeout(pending.timeout);if(data.error)pending.reject(Object.assign(new Error(data.error),{code:data.error}));else pending.resolve(data.result);}
 if(bridge)bridge.onmessage=event=>accept(event.data);
 function active(){const e=model.entitlement;return !!(e?.active&&e.entitlement==='premium'&&Date.parse(e.subscription_expiry)>Date.now());}
 function label(){return active()?'Premium':'Free plan';}
 function update(){updatePlanLabel();if($('#pro-dialog').open)render();if(extraState.screen==='profile')renderExtraScreen();if(!active()&&extraState.screen==='planner')showScreen('profile');}
 function setEntitlement(e){model.entitlement=e;update();}
 function status(){const e=model.entitlement;if(model.message)return model.message;if(active()){if(e.subscription_status==='canceled')return 'Renewal is canceled. Premium remains available until the verified expiry date.';if(e.subscription_status==='in_grace_period')return 'There is a payment issue. Google Play currently allows Premium access during the grace period.';return 'Your Premium subscription is verified and active.';}if(e?.subscription_status==='expired')return 'Your subscription has expired. Subscribe again to restore Premium access.';if(['on_hold','paused','invalid','pending_purchase_canceled'].includes(e?.subscription_status))return 'Your subscription is inactive. Check Google Play to manage your subscription.';if(e?.subscription_status==='pending')return errorMessages.pending_purchase;if(e?.subscription_status==='verification_pending')return errorMessages.verification_pending;if(!bridge)return errorMessages.native_required;if(!model.signedIn)return errorMessages.sign_in_required;return model.context?.billing_enabled?'Choose the plan that fits your kitchen.':errorMessages.billing_disabled;}
 function render(){
  const available=!!(bridge&&model.context?.billing_enabled&&model.catalog.length&&model.signedIn&&!active());
  const current=model.catalog.find(p=>p.id===model.selected);
  const dates=model.entitlement?.subscription_expiry?new Intl.DateTimeFormat(window.Languages?.code()||'en',{dateStyle:'medium'}).format(new Date(model.entitlement.subscription_expiry)):'';
  const iconName=model.busy?'clock':active()?'check':model.phase==='error'?'info':'lock';
  $('#pro-dialog').innerHTML=`<div class="modal-top"><div class="pro-logo">pantry<span>PREMIUM</span></div><button class="icon-button" data-close aria-label="Close Premium">${icon('x')}</button></div><div class="pro-hero"><div class="pro-symbol">${icon('sparkles')}</div><span class="eyebrow muted">${text('MORE POSSIBILITY, EVERY DAY')}</span><h2 id="pro-title">CookAI Premium</h2><p class="modal-intro">${text('Your everyday kitchen, with a little more magic.')}</p></div><ul class="benefits premium-benefits">${['Unlimited ingredient scans','Unlimited AI recipes','AI Chef','Weekly meal planner','Advanced substitutions','Nutrition estimates'].map(x=>`<li>${icon('check')}${text(x)}</li>`).join('')}</ul><div class="premium-plans" role="group" aria-label="Subscription plans">${['monthly','annual'].map(id=>{const p=model.catalog.find(x=>x.id===id);const name=id==='monthly'?'Monthly':'Annual';return `<button class="premium-plan ${model.selected===id?'selected':''}" data-premium-plan="${id}" aria-pressed="${model.selected===id}" ${model.busy||(model.catalog.length&&!p)?'disabled':''}><span class="plan-radio"></span><span><strong>${text(name)}</strong><small>${text(id==='monthly'?'Billed monthly':'Billed annually')}</small></span><span class="plan-price"><b>${escapeHTML(p?.formattedPrice||(model.catalog.length?t('Unavailable'):(id==='monthly'?'N$49':'N$399')))}</b><small>${text(id==='monthly'?'/month':'/year')}</small></span></button>`;}).join('')}</div><p class="price-note">${text(model.catalog.length?'Prices supplied by Google Play. Your purchase sheet confirms the total.':'Planned prices: Monthly — N$49/month · Annual — N$399/year. Google Play confirms the available price before purchase.')}</p><div class="premium-status ${active()?'verified':''}" role="status" aria-live="polite">${icon(iconName)}<div><strong>${text(model.busy?'Please wait…':active()?'Premium is active':model.phase==='canceled'?'Purchase canceled':model.phase==='error'?'Unable to complete':model.entitlement?.subscription_status==='expired'?'Subscription expired':!bridge?'Android purchase required':'Your subscription')}</strong><p>${text(status())}</p>${dates?`<small>${text(active()?'Access through':'Expiry date')}: ${escapeHTML(dates)}</small>`:''}</div></div>${!model.signedIn&&bridge?`<button class="button primary full" data-premium="signin" ${model.busy?'disabled':''}>${text('Sign in or create account')} ${icon('arrow')}</button>`:`<button class="button primary full" data-premium="purchase" ${!available||model.busy||!current?'disabled':''}>${text(active()?'Premium is active':!bridge?'Available on Android':model.busy?'Please wait…':'Subscribe with Google Play')} ${icon('arrow')}</button>`}<div class="premium-links"><button class="text-button" data-premium="restore" ${model.busy?'disabled':''}>${text('Restore purchases')}</button><button class="text-button" data-premium="manage">${text('Manage Subscription')} ${icon('arrow')}</button></div>${bridge&&model.signedIn?`<button class="free-link" data-premium="signout">${text('Sign out')}</button>`:''}<p class="checkout-note">${text('Payment is handled by Google Play. Subscriptions renew automatically unless canceled in Google Play. No card details are stored by Pantry.')}</p><p class="checkout-note">${text('Prototype: AI features require a connected service before subscriptions can launch.')}</p>`;
  $('#pro-dialog').setAttribute('aria-labelledby','pro-title');
 }
 async function run(action){if(model.busy)return;model.busy=true;model.phase='loading';model.message=action==='restore'?'Checking your Google Play purchases…':action==='purchase'?'Complete your purchase in Google Play.':action==='signin'?'Sign in securely to continue.':'Checking your subscription…';render();
  try{if(action==='load'||action==='signin'){if(action==='signin')await request('signin');const data=await request('catalog');model.context=data.context;model.catalog=data.products||[];if(model.catalog.length&&!model.catalog.some(p=>p.id===model.selected))model.selected=model.catalog[0].id;model.signedIn=data.signed_in;setEntitlement(data.entitlement||null);model.phase='ready';model.message='';}
   else if(action==='purchase'){const result=await request('purchase',{plan:model.selected});setEntitlement(result);model.phase=active()?'success':'pending';model.message=active()?'Purchase successful. Your Premium entitlement is verified.':errorMessages[result.subscription_status==='pending'?'pending_purchase':'verification_pending'];}
   else if(action==='restore'){const result=await request('restore');setEntitlement(result);model.phase=active()?'success':'ready';model.message=active()?'Purchase restored. Premium is available on this account.':result.subscription_status==='expired'?'Your subscription has expired. Subscribe again to restore Premium access.':errorMessages.no_purchases;}
   else if(action==='signout'){await request('signout');model.context=null;model.catalog=[];model.signedIn=false;setEntitlement(null);model.phase='ready';model.message='';}
  }catch(error){if(!['purchase_canceled','already_subscribed'].includes(error.code))setEntitlement(null);model.phase=error.code==='purchase_canceled'?'canceled':error.code==='pending_purchase'?'pending':'error';model.message=errorMessages[error.code]||errorMessages.service_unavailable;}
  finally{model.busy=false;update();}
 }
 function open(){render();openDialog('#pro-dialog');if(bridge&&!loaded){loaded=true;run('load');}}
 function showError(error){if(['native_required','premium_required','sign_in_required','invalid_account_session','verify_your_email'].includes(error.code)){model.message=errorMessages[error.code];open();}else toast(errorText(error));}
 async function feature(name,payload){try{return await request('feature',{name,body:payload});}catch(error){if(['premium_required','invalid_account_session','verification_unavailable'].includes(error.code))setEntitlement(null);throw error;}}
 document.addEventListener('click',async event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.premiumPlan){model.selected=b.dataset.premiumPlan;render();return;}const action=b.dataset.premium;if(!action)return;if(action==='manage'){if(bridge){try{await request('manage');}catch(error){toast(errorText(error));}}else window.open('https://play.google.com/store/account/subscriptions','_blank','noopener,noreferrer');return;}await run(action);});
 window.addEventListener('pantry-entitlement',event=>{setEntitlement(event.detail);model.message='';update();});
 window.addEventListener('pantry-verification-error',()=>{setEntitlement(null);model.message=errorMessages.verification_unavailable;update();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&bridge&&model.signedIn)run('load');});
 setInterval(()=>{if(model.entitlement?.active&&!active()){model.entitlement.active=false;model.entitlement.subscription_status='expired';model.message='';update();}},15000);
 updatePlanLabel=function(){$('#plan-label').textContent=t(label());};
 renderPro=open;
 return {label,feature,showError,errorText,refresh:()=>run('load'),render};
})();
