const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = path.join(__dirname, 'public');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).on('error', () => { res.writeHead(404).end(); }).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], failures = [], passed = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failures.push(response.url()); });
  const check = async (name, fn) => { await fn(); passed.push(name); console.log('PASS', name); };
  const fillIngredients = async value => { await page.locator('#ingredient-input').fill(value); await page.locator('#ingredient-form').evaluate(form => form.requestSubmit()); };
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => document.fonts.ready);
    await check('Initial sample pantry and desktop layout', async () => {
      assert.equal(await page.locator('.ingredient-chip').count(), 3);
      assert.equal(await page.locator('#recipe-grid .recipe-card').count(), 3);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: '/tmp/pantry-dark-desktop.png', fullPage: true });
    });
    await check('Recipe matching for spaghetti, tomato paste and ground meat', async () => {
      await page.locator('#find-recipes').click();
      assert.match(await page.locator('#results-title').innerText(), /2 recipes/);
      assert.equal(await page.locator('#recipe-grid .match-badge:not(.missing)').count(), 2);
    });
    await check('Ingredient add, aliases, deduplication, edit and remove', async () => {
      await fillIngredients('Egg, garlic, garlic, GROUND BEEF');
      assert.equal(await page.locator('.ingredient-chip').count(), 5);
      await page.getByRole('button', { name: 'Edit garlic', exact: true }).click();
      await page.locator('#edit-input').fill('onion');
      await page.getByRole('button', { name: 'Save ingredient', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Edit onion', exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Remove onion', exact: true }).click();
      assert.equal(await page.locator('.ingredient-chip').count(), 4);
    });
    await check('Staples affect ready-to-cook matches', async () => {
      await page.locator('#staples').uncheck();
      assert.equal(await page.locator('#recipe-grid .match-badge:not(.missing)').count(), 0);
      await page.locator('#staples').check();
    });
    await check('Recipe details, serving scaling, ingredient checklist and cooking flow', async () => {
      await page.locator('[data-recipe="beef-pasta"]').first().click();
      assert.match(await page.locator('#recipe-dialog').innerText(), /200 g spaghetti/);
      await page.getByRole('button', { name: 'More servings', exact: true }).click();
      assert.match(await page.locator('#recipe-dialog').innerText(), /300 g spaghetti/);
      await page.locator('[data-check-ingredient]').first().check();
      assert.equal(await page.locator('.detail-ingredient.checked').count(), 1);
      await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
      await page.locator('[data-action="start-cooking"]').click();
      await page.locator('[data-action="cook-next"]').click();
      await page.locator('[data-action="cook-prev"]').click();
      assert.match(await page.locator('.cook-label').innerText(), /Step 1 of 3/i);
      for (let i = 0; i < 3; i++) await page.locator('[data-action="cook-next"]').click();
      assert.match(await page.locator('#recipe-dialog').innerText(), /Made something good/);
      await page.locator('[data-action="finish-cooking"]').click();
    });
    await check('Saved recipes and pantry survive reload', async () => {
      await page.reload();
      assert.equal(await page.locator('.ingredient-chip').count(), 4);
      await page.locator('.sidebar [data-nav="recipes"]').click();
      assert.equal(await page.locator('#saved-grid .recipe-card').count(), 1);
      await page.locator('#saved-grid [data-save="beef-pasta"]').click();
      assert.match(await page.locator('#saved-grid').innerText(), /A home for your go-to meals/);
      await page.locator('.sidebar [data-nav="kitchen"]').click();
    });
    await check('Sample detection review edits and adds to pantry', async () => {
      await page.locator('.capture-card [data-action="sample"]').click();
      assert.equal(await page.locator('.detected-row').count(), 6);
      await page.locator('[data-detected="0"]').fill('potato');
      await page.locator('[data-remove-detected="1"]').click();
      await page.locator('#detected-input').fill('cheese');
      await page.locator('#detected-form').evaluate(form => form.requestSubmit());
      await page.locator('#confirm-detected').click();
      assert.equal(await page.getByRole('button', { name: 'Edit potato', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Edit cheese', exact: true }).count(), 1);
    });
    await check('Photo file upload and explicit simulated recognition', async () => {
      await page.locator('#photo-input').setInputFiles(path.join(root, 'assets/pasta.jpg'));
      await page.locator('#capture-dialog[open]').waitFor();
      assert.match(await page.locator('#scan-note').innerText(), /not a reading of your photo/);
      assert.equal(await page.locator('#review-photo img').evaluate(img => img.complete && img.naturalWidth > 0), true);
      await page.keyboard.press('Escape');
      await page.locator('#photo-input').setInputFiles({ name: 'wrong.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
      assert.equal(await page.locator('#capture-dialog[open]').count(), 0);
      assert.match(await page.locator('#toast').innerText(), /JPG, PNG/);
    });
    await check('Vegetarian and time filters change results', async () => {
      await page.locator('#find-recipes').click();
      await page.locator('[data-filter="vegetarian"]').click();
      assert.equal(await page.locator('#recipe-grid [data-recipe="beef-pasta"]').count(), 0);
      await page.locator('[data-filter="quick"]').click();
      assert.equal(await page.locator('#recipe-grid [data-recipe="meat-rice"]').count(), 0);
      await page.locator('[data-filter="all"]').click();
    });
    await check('Empty and unmatched pantry states', async () => {
      await page.locator('[data-action="clear"]').click();
      await page.locator('#find-recipes').click();
      assert.match(await page.locator('#pantry-error').innerText(), /at least one ingredient/);
      await fillIngredients('dragonfruit');
      await page.locator('#find-recipes').click();
      assert.match(await page.locator('#recipe-grid').innerText(), /No sample recipes match/);
    });
    await check('User-entered text renders safely', async () => {
      await fillIngredients('<img src=x onerror=alert(1)>');
      assert.equal(await page.locator('#ingredient-chips img').count(), 0);
      assert.match(await page.locator('#ingredient-chips').innerText(), /<img/);
    });
    await check('Premium has correct plans, no local unlock, and safe browser restore', async () => {
      await page.locator('.topbar [data-action="open-pro"]').click();
      assert.equal(await page.locator('#pro-title').innerText(), 'CookAI Premium');
      assert.match(await page.locator('#pro-dialog').innerText(), /N\$49/);
      assert.match(await page.locator('#pro-dialog').innerText(), /N\$399/);
      await page.locator('[data-premium-plan="monthly"]').click();
      assert.equal(await page.locator('[data-premium-plan="monthly"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-premium="purchase"]').isDisabled(), true);
      await page.locator('[data-premium="restore"]').click();
      assert.match(await page.locator('.premium-status').innerText(), /private web preview cannot make purchases/);
      await page.keyboard.press('Escape');
      await page.evaluate(() => { const data=JSON.parse(localStorage.getItem('pantry-prototype-v1')||'{}'); data.pro=true; localStorage.setItem('pantry-prototype-v1',JSON.stringify(data)); });
      await page.reload();
      assert.equal(await page.locator('#plan-label').innerText(), 'Free plan');
      await page.locator('.sidebar [data-extra="planner"]').click();
      assert.equal(await page.locator('#pro-dialog[open]').count(), 1);
      assert.equal(await page.locator('.plan-row').count(), 0);
      await page.keyboard.press('Escape');
    });
    await check('Mobile flow and responsive widths 360, 390, 768, 1440', async () => {
      await page.locator('[data-action="clear"]').click();
      await fillIngredients('spaghetti, tomato paste, ground meat');
      for (const width of [360, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: '/tmp/pantry-dark-mobile.png', fullPage: true });
      await page.screenshot({ path: '/tmp/pantry-dark-mobile-top.png' });
      await page.locator('#find-recipes').click();
      await page.locator('#recipe-grid [data-recipe="beef-pasta"]').click();
      await page.screenshot({ path: '/tmp/pantry-dark-mobile-detail.png' });
      assert.equal(await page.locator('#recipe-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.getByRole('button', { name: 'Close recipe', exact: true }).click();
      await page.locator('.mobile-nav [data-nav="recipes"]').click();
      assert.equal(await page.locator('#saved-view').isVisible(), true);
      await page.locator('.topbar [data-action="open-pro"]').click();
      assert.equal(await page.locator('#pro-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.screenshot({ path: '/tmp/pantry-dark-mobile-plus.png' });
    });
    await page.keyboard.press('Escape');
    await check('Reference scanner and editable detection flow on mobile', async () => {
      await page.locator('.mobile-nav [data-action="capture"]').click();
      assert.equal(await page.locator('#scanner-dialog').isVisible(), true);
      await page.screenshot({ path: '/tmp/pantry-dark-scanner.png' });
      await page.locator('[data-extra="sample-scan"]').click();
      assert.equal(await page.locator('#scanner-dialog[open]').count(), 0);
      assert.equal(await page.locator('.detected-row').count(), 6);
      await page.screenshot({ path: '/tmp/pantry-dark-detection.png' });
      await page.locator('#confirm-detected').click();
      assert.equal(await page.locator('.ingredient-chip').count(), 9);
    });
    await check('Advanced filters, quick actions and recipe search', async () => {
      await page.locator('#results [data-extra="filters"]').click();
      await page.locator('[data-filter-choice="time"][data-value="15"]').click();
      await page.locator('[data-filter-choice="diet"][data-value="vegetarian"]').click();
      await page.locator('[data-filter-choice="ready"][data-value="true"]').click();
      await page.screenshot({ path: '/tmp/pantry-dark-filters.png' });
      await page.locator('[data-extra="apply-filters"]').click();
      assert.equal(await page.locator('#recipe-grid .recipe-card').count(), 1);
      assert.equal(await page.locator('#recipe-grid [data-recipe="spinach-eggs"]').count(), 1);
      await page.locator('[data-quick="ready"]').click();
      assert.equal(await page.locator('#recipe-grid .match-badge.missing').count(), 0);
      await page.locator('#recipe-search').fill('rice');
      await page.locator('#recipe-search-form').evaluate(form => form.requestSubmit());
      assert.equal(await page.locator('#recipe-grid .recipe-card').count(), 3);
      await page.locator('#recipe-sort').selectOption('fastest');
      assert.match(await page.locator('#recipe-grid .recipe-card').first().innerText(), /Golden garlic rice/);
    });
    await check('AI Chef requires verified Premium; cooking timer still works', async () => {
      await page.locator('#recipe-grid [data-recipe="garlic-rice"]').click();
      await page.locator('[data-action="start-cooking"]').click();
      await page.screenshot({ path: '/tmp/pantry-dark-cooking.png' });
      await page.locator('#recipe-dialog [data-extra="chef"]').click();
      await page.locator('[data-chef-question="How long does this recipe take?"]').click();
      assert.equal(await page.locator('#pro-dialog[open]').count(), 1);
      assert.match(await page.locator('#pro-dialog').innerText(), /private web preview cannot make purchases/);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.locator('#recipe-dialog [data-extra="timer"]').click();
      await page.locator('#timer-minutes').fill('1');
      await page.locator('[data-extra="set-timer"]').click();
      await page.locator('[data-extra="toggle-timer"]').click();
      await page.waitForFunction(() => document.querySelector('#timer-display').textContent !== '01:00', null, { timeout: 4000 });
      assert.notEqual(await page.locator('#timer-display').innerText(), '01:00');
      await page.locator('[data-extra="toggle-timer"]').click();
      assert.equal(await page.locator('#toggle-timer').innerText(), 'Start timer');
      await page.locator('[data-extra="reset-timer"]').click();
      assert.equal(await page.locator('#timer-display').innerText(), '05:00');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    });
    await check('Profile preferences, premium planner and shopping checklist', async () => {
      await page.locator('.mobile-nav [data-extra="profile"]').click();
      await page.locator('#profile-diet').selectOption('vegetarian');
      await page.locator('#profile-household').selectOption('4');
      await page.locator('#profile-form').evaluate(form => form.requestSubmit());
      await page.reload();
      await page.locator('.mobile-nav [data-extra="profile"]').click();
      assert.equal(await page.locator('#profile-household').inputValue(), '4');
      await page.locator('#extras-view [data-extra="planner"]').click();
      assert.equal(await page.locator('#pro-dialog[open]').count(), 1);
      assert.equal(await page.locator('[data-premium="purchase"]').isDisabled(), true);
      await page.keyboard.press('Escape');
      await page.locator('#extras-view [data-extra="shopping"]').click();
      await page.locator('#shopping-input').fill('yogurt');
      await page.locator('#shopping-form').evaluate(form => form.requestSubmit());
      await page.getByRole('checkbox', {name:/Yogurt/}).check();
      await page.locator('[data-extra="clear-bought"]').click();
      assert.equal(await page.getByRole('checkbox', {name:/Yogurt/}).count(), 0);
    });
    await check('Ingredient date tracking and welcome screen preserve Pantry identity', async () => {
      await page.locator('.mobile-nav [data-extra="profile"]').click();
      await page.locator('#extras-view [data-extra="expiry"]').click();
      await page.locator('[data-expiry="tomatoes"]').fill('2026-09-25');
      await page.locator('[data-extra="expiry-recipes"]').click();
      assert.match(await page.locator('#results-description').innerText(), /tomatoes/);
      await page.locator('.mobile-nav [data-extra="profile"]').click();
      await page.locator('#extras-view [data-extra="welcome"]').click();
      assert.match(await page.locator('.splash-preview .brand').innerText(), /pantry/);
      assert.equal(await page.locator('.splash-preview .brand-icon svg').count(), 1);
      await page.locator('.splash-preview [data-nav="kitchen"]').click();
      assert.equal(await page.locator('#kitchen-view').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
    await check('Language changes navigation and Premium, and persists after reload', async () => {
      await page.locator('#top-language').selectOption('af');
      assert.equal(await page.locator('.mobile-nav [data-nav="kitchen"] span').innerText(), 'Tuis');
      await page.locator('.topbar [data-action="open-pro"]').click();
      assert.match(await page.locator('#pro-dialog').innerText(), /Onbeperkte bestanddeelskanderings/);
      await page.keyboard.press('Escape');
      await page.reload();
      assert.equal(await page.locator('#top-language').inputValue(), 'af');
      await page.locator('.mobile-nav [data-extra="profile"]').click();
      await page.locator('#profile-language').selectOption('pt');
      assert.match(await page.locator('#extras-view').innerText(), /Meu perfil/);
      await page.locator('.topbar [data-action="open-pro"]').click();
      assert.match(await page.locator('#pro-dialog').innerText(), /Gerenciar assinatura/);
      assert.equal(await page.locator('#pro-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.screenshot({ path:'/tmp/pantry-premium-portuguese.png' });
      await page.keyboard.press('Escape');
      await page.locator('#top-language').selectOption('en');
      assert.equal(await page.locator('.mobile-nav [data-nav="kitchen"] span').innerText(), 'Home');
    });
    assert.deepEqual(errors, [], 'No JavaScript errors');
    assert.deepEqual(failures, [], 'No failed assets');
    console.log(JSON.stringify({ passed: passed.length, javascriptErrors: errors, failedAssets: failures }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exit(1); });
