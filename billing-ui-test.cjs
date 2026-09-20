/* Test-only fake native transport. Never copied into public/ or the Android assets. */
const { chromium }=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
(async()=>{
 const root=path.join(__dirname,'public');
 const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;const file=path.join(root,pathname==='/'?'index.html':pathname);res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.jpg':'image/jpeg','.svg':'image/svg+xml','.ttf':'font/ttf'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).on('error',()=>res.writeHead(404).end()).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.__scenario='free';window.__calls=[];
  const entitlement=()=>({entitlement:'premium',active:['active','canceled-renewal'].includes(window.__scenario),subscription_status:window.__scenario==='expired'?'expired':window.__scenario==='canceled-renewal'?'canceled':window.__scenario==='pending'?'pending':window.__scenario==='active'?'active':'none',subscription_expiry:window.__scenario==='expired'?'2025-01-01T00:00:00Z':'2099-01-01T00:00:00Z',platform:'google_play'});
  window.PantryNative={onmessage:null,postMessage(raw){const request=JSON.parse(raw);window.__calls.push(request);setTimeout(()=>{let result,error;
   switch(request.action){
    case 'catalog':result={signed_in:true,context:{billing_enabled:true},products:[{id:'monthly',formattedPrice:'N$57.00'},{id:'annual',formattedPrice:'N$450.00'}],entitlement:entitlement()};break;
    case 'purchase':if(window.__scenario==='canceled')error='purchase_canceled';else if(window.__scenario==='failed')error='purchase_failed';else if(window.__scenario==='network')error='verification_unavailable';else if(window.__scenario==='pending')error='pending_purchase';else if(window.__scenario==='verification')result={...entitlement(),active:false,subscription_status:'verification_pending'};else {window.__scenario='active';result=entitlement();}break;
    case 'restore':result=entitlement();break;
    case 'feature':if(!entitlement().active)error='premium_required';else result={recipe_ids:['tomato-pasta','green-pasta','tomato-eggs','egg-rice','garlic-rice','spinach-eggs','tomato-pasta']};break;
    case 'manage':result={};break;
    case 'signout':window.__scenario='free';result={};break;
   }
   window.PantryNative.onmessage({data:JSON.stringify({id:request.id,result,error})});},120);}};
 });
 const pass=name=>console.log('PASS',name);
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.topbar [data-action="open-pro"]').click();
  assert.match(await page.locator('.premium-status').innerText(),/Please wait/);
  await page.locator('[data-premium="purchase"]:not([disabled])').waitFor();
  assert.match(await page.locator('.premium-plans').innerText(),/N\$57.00/);
  assert.match(await page.locator('.premium-plans').innerText(),/N\$450.00/);
  pass('Loading state and dynamic Google Play product prices');
  for(const [scenario,message] of [['canceled','Purchase canceled'],['failed','could not be completed'],['network','could not verify'],['pending','Payment is pending'],['verification','purchase is being verified']]){
   await page.evaluate(value=>window.__scenario=value,scenario);
   await page.locator('[data-premium="purchase"]').click();
   await page.waitForFunction(expected=>document.querySelector('.premium-status').textContent.includes(expected),message);
   assert.equal(await page.locator('#plan-label').innerText(),'Free plan');pass(scenario+' stays locked');
  }
  await page.evaluate(()=>window.__scenario='free');
  await page.locator('[data-premium-plan="monthly"]').click();
  await page.locator('[data-premium="purchase"]').click();
  await page.waitForFunction(()=>document.querySelector('.premium-status').textContent.includes('Purchase successful'));
  assert.equal(await page.locator('#plan-label').innerText(),'Premium');
  assert.equal(await page.evaluate(()=>window.__calls.filter(x=>x.action==='purchase').at(-1).payload.plan),'monthly');pass('Monthly purchase sends selected plan and displays verified success');
  await page.locator('[data-premium="manage"]').click();
  assert.equal(await page.evaluate(()=>window.__calls.at(-1).action),'manage');
  await page.keyboard.press('Escape');
  await page.locator('.mobile-nav [data-extra="profile"]').click();
  await page.locator('#extras-view [data-extra="planner"]').click();
  await page.locator('.plan-row').first().waitFor();assert.equal(await page.locator('.plan-row').count(),7);
  assert.equal(await page.evaluate(()=>window.__calls.some(x=>x.action==='feature'&&x.payload.name==='meal-plan')),true);pass('Premium planner requests the protected backend feature');
  await page.locator('.topbar [data-action="open-pro"]').click();
  await page.evaluate(()=>window.__scenario='expired');
  await page.locator('[data-premium="restore"]').click();
  await page.waitForFunction(()=>document.querySelector('.premium-status').textContent.includes('subscription has expired'));
  assert.equal(await page.locator('#plan-label').innerText(),'Free plan');
  assert.equal(await page.locator('.plan-row').count(),0);pass('Expired restore removes Premium and clears planner view');
  await page.evaluate(()=>window.__scenario='canceled-renewal');
  await page.locator('[data-premium="restore"]').click();
  await page.waitForFunction(()=>document.querySelector('.premium-status').textContent.includes('Purchase restored'));
  assert.equal(await page.locator('#plan-label').innerText(),'Premium');
  await page.evaluate(()=>Premium.refresh());
  await page.waitForFunction(()=>document.querySelector('.premium-status').textContent.includes('Renewal is canceled'));
  pass('Restoration and cancellation preserve verified paid-through access');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('pantry-verification-error')));
  assert.equal(await page.locator('#plan-label').innerText(),'Free plan');
  pass('Failed background verification removes displayed access');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1);});
