// publish.js – FINAL ROBUST VERSION
// Uses storageState.json if present (no login needed)
// Falls back to login only if storageState.json is missing

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const admin = require('firebase-admin');

const FALLBACK_IMAGE_URL =
  'https://d1yei2z3i6k35z.cloudfront.net/thumb_150/697801a52e93c_MAINLOGO.PNG';

const TIMEOUT_MS = Number(process.env.PUBLISH_TIMEOUT_MS || 45000);
const SHORT_WAIT = 800;

async function initFirebase() {
  const svcBase64 =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (!svcBase64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');

  const svcJson = Buffer.from(svcBase64, 'base64').toString('utf8');
  const svc = JSON.parse(svcJson);

  admin.initializeApp({
    credential: admin.credential.cert(svc),
    projectId: process.env.FIREBASE_PROJECT_ID || svc.project_id,
  });

  return admin.firestore();
}

function buildDescription(product) {
  if (product.description_html) return product.description_html;
  return `<h1>${product.title}</h1>
<p>Category: ${product.category || ''}</p>
<p>Price: ${
    product.price_sar
      ? product.price_sar + ' SAR'
      : product.price_usd
      ? product.price_usd + ' USD'
      : ''
  }</p>
<p>Profit: ${product.profit_sar ? product.profit_sar + ' SAR' : ''}</p>`;
}

async function waitForAnySelector(page, selectors, opts = {}) {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, {
        state: 'visible',
        timeout: opts.timeout ?? TIMEOUT_MS,
      });
      return sel;
    } catch {}
  }
  return null;
}

async function clickAny(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function createProductViaUI(page, product) {
  await page.goto('https://systeme.io/products/new', {
    waitUntil: 'networkidle',
  });

  await page.waitForLoadState('networkidle');

  const titleSelectors = [
    'input[name="title"]',
    'input[placeholder="Product name"]',
    'textarea[name="title"]',
    'input[aria-label="Product name"]',
  ];

  const foundTitleSel = await waitForAnySelector(page, titleSelectors);
  if (!foundTitleSel) {
    await page.screenshot({
      path: `debug-title-missing-${Date.now()}.png`,
      fullPage: true,
    });
    throw new Error('Title input not found');
  }

  const titleInput = await page.$(foundTitleSel);
  await titleInput.fill(product.title || '');

  const priceSelectors = [
    'input[name="price"]',
    'input[placeholder="Price"]',
    'input[type="number"]',
  ];

  const foundPriceSel = await waitForAnySelector(page, priceSelectors, {
    timeout: 3000,
  });

  if (foundPriceSel) {
    const priceInput = await page.$(foundPriceSel);
    const price =
      product.price_usd ||
      (product.price_sar ? (product.price_sar / 3.75).toFixed(2) : '');
    await priceInput.fill(String(price));
  }

  const html = buildDescription(product);
  const textarea = await page.$(
    'textarea[name="description"], textarea[placeholder*="description"]'
  );

  if (textarea) {
    await textarea.fill(html);
  } else {
    const editable = await page.$('[contenteditable="true"]');
    if (editable) {
      await editable.click();
      await editable.fill('');
      await editable.type(html, { delay: 5 });
    }
  }

  const images =
    Array.isArray(product.images) && product.images.length
      ? product.images
      : [FALLBACK_IMAGE_URL];

  for (const imgUrl of images) {
    try {
      const addBtn = await page.$(
        'button:has-text("Add image"), button:has-text("Upload image"), button:has-text("Add media")'
      );
      if (addBtn) {
        await addBtn.click();
        const urlInput = await page.$(
          'input[placeholder*="http"], input[name="image_url"], input[type="url"]'
        );
        if (urlInput) {
          await urlInput.fill(imgUrl);
          await clickAny(page, [
            'button:has-text("Insert")',
            'button:has-text("OK")',
            'button:has-text("Upload")',
          ]);
          await page.waitForTimeout(SHORT_WAIT);
        }
      }
    } catch {}
  }

  const saveSelectors = [
    'button:has-text("Save")',
    'button:has-text("Create")',
    'button:has-text("Publish")',
  ];

  const foundSave = await waitForAnySelector(page, saveSelectors, {
    timeout: 5000,
  });

  if (!foundSave) {
    await page.screenshot({
      path: `debug-save-missing-${Date.now()}.png`,
      fullPage: true,
    });
    throw new Error('Save button not found');
  }

  const saveBtn = await page.$(foundSave);
  await saveBtn.click();

  const successSelectors = [
    'text=Product created',
    'text=Saved',
    'text=Success',
  ];

  const successSel = await waitForAnySelector(page, successSelectors, {
    timeout: TIMEOUT_MS,
  });

  return !!successSel;
}

(async () => {
  const db = await initFirebase();
  const col = process.env.FIREBASE_COLLECTION || 'products';

  const q = db
    .collection(col)
    .where('status', '==', 'approved')
    .where('published', '==', false)
    .limit(20);

  const snapshot = await q.get();
  if (snapshot.empty) {
    console.log('No approved unpublished products found.');
    process.exit(0);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const storageStatePath = fs.existsSync('storageState.json')
    ? 'storageState.json'
    : null;

  const context = storageStatePath
    ? await browser.newContext({ storageState: storageStatePath })
    : await browser.newContext();

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  // If no storage state → login
  if (!storageStatePath) {
    const user = process.env.SYSTEME_USER;
    const pass = process.env.SYSTEME_PASS;

    await page.goto('https://systeme.io/login', { waitUntil: 'networkidle' });

    await waitForAnySelector(page, ['input[type="email"]']);
    await page.fill('input[type="email"]', user);
    await page.fill('input[type="password"]', pass);

    await clickAny(page, [
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'button[type="submit"]',
    ]);

    const postLoginSel = await waitForAnySelector(
      page,
      ['text=Dashboard', 'a:has-text("Products")'],
      { timeout: TIMEOUT_MS }
    );

    if (!postLoginSel) {
      const ts = Date.now();
      await page.screenshot({
        path: `debug-login-failed-${ts}.png`,
        fullPage: true,
      });
      fs.writeFileSync(
        `debug-login-failed-${ts}.html`,
        await page.content(),
        'utf8'
      );
      throw new Error('Login failed');
    }
  }

  for (const doc of snapshot.docs) {
    const product = doc.data();
    product._id = doc.id;

    product.title = product.title || `Product ${product._id}`;
    if (!product.description_html && product.description)
      product.description_html = product.description;

    if (!product.price_usd && product.price_sar)
      product.price_usd = Number((product.price_sar / 3.75).toFixed(2));

    if (!Array.isArray(product.images) || product.images.length === 0)
      product.images = [FALLBACK_IMAGE_URL];

    try {
      console.log('Publishing', product.title);
      const ok = await createProductViaUI(page, product);

      if (ok) {
        await db.collection(col).doc(doc.id).update({
          published: true,
          published_at: Date.now(),
          published_by_job: process.env.GITHUB_RUN_ID || 'local-run',
        });
        console.log('Published', product.title);
      } else {
        console.error('Failed to detect success for', product.title);
      }
    } catch (err) {
      console.error('Error publishing', product.title, err.message);
      const file = path.join(
        process.cwd(),
        `error-${doc.id}-${Date.now()}.png`
      );
      await page.screenshot({ path: file, fullPage: true });
    }

    await page.waitForTimeout(1500 + Math.random() * 1000);
  }

  await browser.close();
  process.exit(0);
})();
