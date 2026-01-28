// publish.js
// Usage: node publish.js
// Requires env vars: FIREBASE_SERVICE_ACCOUNT (base64 JSON) or FIREBASE_SERVICE_ACCOUNT_BASE64,
// FIREBASE_PROJECT_ID, SYSTEME_USER, SYSTEME_PASS, FIREBASE_COLLECTION (default "products")

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const admin = require('firebase-admin');

// Global fallback image (your logo on systeme.io)
const FALLBACK_IMAGE_URL = 'https://d1yei2z3i6k35z.cloudfront.net/thumb_150/697801a52e93c_MAINLOGO.PNG';

// Default timeouts (ms)
const TIMEOUT_MS = Number(process.env.PUBLISH_TIMEOUT_MS || 30000);
const SHORT_WAIT = 800;

async function initFirebase() {
  // Accept either FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_BASE64 for compatibility
  const svcBase64 = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!svcBase64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT env var (or FIREBASE_SERVICE_ACCOUNT_BASE64)');
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
  // fallback simple HTML
  return `<h1>${product.title}</h1>
<p>Category: ${product.category || ''}</p>
<p>Price: ${product.price_sar ? product.price_sar + ' SAR' : product.price_usd ? product.price_usd + ' USD' : ''}</p>
<p>Profit: ${product.profit_sar ? product.profit_sar + ' SAR' : ''}</p>`;
}

async function waitForAnySelector(page, selectors, opts = {}) {
  // Try each selector until one is found and visible
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: opts.timeout ?? TIMEOUT_MS });
      return sel;
    } catch (e) {
      // continue to next
    }
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
    } catch (e) {
      // ignore and continue
    }
  }
  return false;
}

async function createProductViaUI(page, product) {
  // Navigate to product creation page - adjust if systeme.io uses different URL
  await page.goto('https://app.systeme.io/products/new', { waitUntil: 'networkidle' });

  // Ensure page is ready
  await page.waitForLoadState('networkidle');

  // Wait for the form to appear - selectors may need adjustment
  const titleSelectors = [
    'input[name="title"]',
    'input[placeholder="Product name"]',
    'textarea[name="title"]',
    'input[aria-label="Product name"]',
    'input[placeholder*="Product"]'
  ];
  const foundTitleSel = await waitForAnySelector(page, titleSelectors, { timeout: TIMEOUT_MS });
  if (!foundTitleSel) {
    // capture debug screenshot for investigation
    try { await page.screenshot({ path: `debug-title-missing-${Date.now()}.png`, fullPage: true }); } catch (e) {}
    throw new Error('Title input not found - update selector in script');
  }
  const titleInput = await page.$(foundTitleSel);
  if (titleInput) await titleInput.fill(product.title || '');

  // Price - try common selectors
  const priceSelectors = ['input[name="price"]', 'input[placeholder="Price"]', 'input[type="number"]', 'input[aria-label*="price"]'];
  const foundPriceSel = await waitForAnySelector(page, priceSelectors, { timeout: 3000 }).catch(() => null);
  if (foundPriceSel) {
    const priceInput = await page.$(foundPriceSel);
    if (priceInput) {
      const price = product.price_usd || (product.price_sar ? (product.price_sar / 3.75).toFixed(2) : '');
      await priceInput.fill(String(price));
    }
  }

  // Tags / category - optional
  if (product.category) {
    const tagSelectors = ['input[placeholder*="tag"]', 'input[name="tags"]', 'input[aria-label*="tag"]', 'input[placeholder*="Category"]'];
    const foundTagSel = await waitForAnySelector(page, tagSelectors, { timeout: 2000 }).catch(() => null);
    if (foundTagSel) {
      const tagInput = await page.$(foundTagSel);
      if (tagInput) {
        await tagInput.fill(product.category);
        await tagInput.press('Enter');
      }
    }
  }

  // Description / HTML editor - many editors are iframes or contenteditable
  const html = buildDescription(product);
  const textareaSel = 'textarea[name="description"], textarea[placeholder*="description"]';
  const textarea = await page.$(textareaSel);
  if (textarea) {
    await textarea.fill(html);
  } else {
    const editable = await page.$('[contenteditable="true"]');
    if (editable) {
      await editable.click();
      await editable.fill('');
      await editable.type(html, { delay: 5 });
    } else {
      // Try frames (rich text editors)
      const frames = page.frames();
      let wrote = false;
      for (const f of frames) {
        try {
          const body = await f.$('body');
          if (body) {
            await f.evaluate((h) => { document.body.innerHTML = h; }, html);
            wrote = true;
            break;
          }
        } catch (e) { /* ignore */ }
      }
      if (!wrote) {
        // fallback: try to paste into any visible textarea-like element
        const anyTextInput = await page.$('textarea, input[type="text"]');
        if (anyTextInput) {
          try { await anyTextInput.fill(html); } catch (e) { /* ignore */ }
        }
      }
    }
  }

  // Images - upload all images; first image treated as main
  const images = Array.isArray(product.images) && product.images.length ? product.images : [FALLBACK_IMAGE_URL];

  // Attempt multiple strategies to attach images; robust but may need selector tuning
  for (let i = 0; i < images.length; i++) {
    const imgUrl = images[i];
    try {
      // Try to click an "Add image" or "Upload image" button
      const addBtnSelectors = [
        'button:has-text("Add image")',
        'button:has-text("Upload image")',
        'button:has-text("Add media")',
        'button:has-text("Add")'
      ];
      const clicked = await clickAny(page, addBtnSelectors);
      if (clicked) {
        // If a URL input appears, paste the URL
        const urlInputSelectors = ['input[placeholder*="http"]', 'input[name="image_url"]', 'input[aria-label*="image"]', 'input[type="url"]'];
        const urlSel = await waitForAnySelector(page, urlInputSelectors, { timeout: 3000 }).catch(() => null);
        if (urlSel) {
          const urlInput = await page.$(urlSel);
          if (urlInput) {
            await urlInput.fill(imgUrl);
            // Confirm insertion
            const okSelectors = ['button:has-text("Insert")', 'button:has-text("OK")', 'button:has-text("Upload")', 'button:has-text("Add")'];
            await clickAny(page, okSelectors);
            await page.waitForTimeout(SHORT_WAIT);
            continue;
          }
        }
      }

      // Fallback: try pasting image URL into any visible input fields
      const anyUrlInput = await page.$('input[type="url"], input[placeholder*="http"]');
      if (anyUrlInput) {
        await anyUrlInput.fill(imgUrl);
        await anyUrlInput.press('Enter');
        await page.waitForTimeout(SHORT_WAIT);
        continue;
      }

      // If none of the above worked, try to set the main image via meta or image uploader widget (best-effort)
      // This is intentionally generic; adjust to your Systeme UI if needed.
    } catch (err) {
      console.warn(`Image handling error for ${imgUrl}:`, err.message);
      // continue to next image
    }
  }

  // Save / Publish - adjust selector to match the Save button
  const saveSelectors = [
    'button:has-text("Save")',
    'button:has-text("Create")',
    'button:has-text("Publish")',
    'button:has-text("Save changes")',
    'button[aria-label="Save"]'
  ];
  const foundSave = await waitForAnySelector(page, saveSelectors, { timeout: 5000 }).catch(() => null);
  if (!foundSave) {
    // try clicking the first button that looks like primary
    const clicked = await clickAny(page, ['button[type="submit"]', 'button.primary', 'button.btn-primary']).catch(() => false);
    if (!clicked) {
      try { await page.screenshot({ path: `debug-save-missing-${Date.now()}.png`, fullPage: true }); } catch (e) {}
      throw new Error('Save button not found - update selector in script');
    }
  } else {
    const saveBtn = await page.$(foundSave);
    if (saveBtn) await saveBtn.click();
  }

  // Wait for success indicator (try multiple success messages)
  const successSelectors = ['text=Product created', 'text=Saved', 'text=Success', 'text=Product published', 'text=Created'];
  const successSel = await waitForAnySelector(page, successSelectors, { timeout: TIMEOUT_MS }).catch(() => null);
  if (successSel) return true;

  // final fallback: small wait and check for URL change or presence of product id in URL
  await page.waitForTimeout(3000);
  const url = page.url();
  if (url && /\/products\/\w+/.test(url)) return true;

  // capture debug screenshot for investigation
  try { await page.screenshot({ path: `debug-no-success-${Date.now()}.png`, fullPage: true }); } catch (e) {}
  return false;
}

(async () => {
  const db = await initFirebase();
  const col = process.env.FIREBASE_COLLECTION || 'products';
  const q = db.collection(col)
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
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Apply default timeout for all waits
  page.setDefaultTimeout(TIMEOUT_MS);

  // Login to systeme.io
  const user = process.env.SYSTEME_USER;
  const pass = process.env.SYSTEME_PASS;
  if (!user || !pass) throw new Error('Missing SYSTEME_USER or SYSTEME_PASS env vars');

  await page.goto('https://app.systeme.io/login', { waitUntil: 'networkidle' });
  // Wait for login form
  await waitForAnySelector(page, ['input[name="email"]', 'input[type="email"]', 'input[placeholder*="email"]'], { timeout: TIMEOUT_MS });
  await page.fill('input[name="email"], input[type="email"]', user);
  await page.fill('input[name="password"], input[type="password"]', pass);
  await clickAny(page, ['button:has-text("Log in")', 'button:has-text("Sign in")', 'button[type="submit"]']);
  // Wait for an element that indicates successful login (Products link or Dashboard)
  const postLoginSel = await waitForAnySelector(page, ['a:has-text("Products")', 'text=Dashboard', 'a:has-text("Funnels")'], { timeout: TIMEOUT_MS }).catch(() => null);
  if (!postLoginSel) {
    try { await page.screenshot({ path: `debug-login-failed-${Date.now()}.png`, fullPage: true }); } catch (e) {}
    throw new Error('Login may have failed - check credentials or interactive login requirements (captcha/2FA).');
  }

  for (const doc of snapshot.docs) {
    const product = doc.data();
    product._id = doc.id;

    // Normalize required fields and apply fallback image
    product.title = product.title || `Product ${product._id}`;
    if (!product.description_html && product.description) {
      product.description_html = product.description;
    }
    if (!product.price_usd && !product.price_sar && typeof product.price === 'number') {
      product.price_sar = product.price_sar || product.price;
      product.price_usd = product.price_usd || Number((product.price_sar / 3.75).toFixed(2));
    }
    if (!Array.isArray(product.images) || product.images.length === 0) {
      product.images = [FALLBACK_IMAGE_URL];
    }
    if (typeof product.published !== 'boolean') {
      product.published = false;
    }
    if (!product.status) {
      product.status = 'approved';
    }

    try {
      console.log('Publishing', product.title || product._id);
      const ok = await createProductViaUI(page, product);
      if (ok) {
        await db.collection(col).doc(doc.id).update({
          published: true,
          published_at: Date.now(),
          published_by_job: process.env.GITHUB_RUN_ID || 'local-run'
        });
        console.log('Published', product.title);
      } else {
        console.error('Failed to detect success for', product.title);
      }
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
    } catch (err) {
      console.error('Error publishing', product.title, err.message);
      const file = path.join(process.cwd(), `error-${doc.id}.png`);
      try {
        await page.screenshot({ path: file, fullPage: true });
        console.log('Saved screenshot', file);
      } catch (sErr) {
        console.warn('Screenshot failed:', sErr.message);
      }
    }
  }

  await browser.close();
  process.exit(0);
})();
