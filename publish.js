// publish.js
// Usage: node publish.js
// Requires env vars: FIREBASE_SERVICE_ACCOUNT (base64 JSON), FIREBASE_PROJECT_ID,
// SYSTEME_USER, SYSTEME_PASS, FIREBASE_COLLECTION (default "products")

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const admin = require('firebase-admin');

// Global fallback image (your logo on systeme.io)
const FALLBACK_IMAGE_URL = 'https://d1yei2z3i6k35z.cloudfront.net/thumb_150/697801a52e93c_MAINLOGO.PNG';

async function initFirebase() {
  const svcBase64 = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!svcBase64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT env var');
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

async function createProductViaUI(page, product) {
  // Navigate to product creation page - adjust if systeme.io uses different URL
  await page.goto('https://app.systeme.io/products/new', { waitUntil: 'networkidle' });

  // Wait for the form to appear - selectors may need adjustment
  await page.waitForSelector('input[name="title"], input[placeholder="Product name"], textarea[name="title"]', { timeout: 15000 });
  const titleInput = await page.$('input[name="title"], input[placeholder="Product name"], textarea[name="title"]');
  await titleInput.fill(product.title || '');

  // Price - try common selectors
  const priceSelector = 'input[name="price"], input[placeholder="Price"], input[type="number"]';
  const priceInput = await page.$(priceSelector);
  if (priceInput) {
    const price = product.price_usd || (product.price_sar ? (product.price_sar / 3.75).toFixed(2) : '');
    await priceInput.fill(String(price));
  }

  // Tags / category - optional
  if (product.category) {
    const tagInput = await page.$('input[placeholder*="tag"], input[name="tags"], input[aria-label*="tag"]');
    if (tagInput) {
      await tagInput.fill(product.category);
      await tagInput.press('Enter');
    }
  }

  // Description / HTML editor - many editors are iframes or contenteditable
  const html = buildDescription(product);
  const textarea = await page.$('textarea[name="description"], textarea[placeholder*="description"]');
  if (textarea) {
    await textarea.fill(html);
  } else {
    const editable = await page.$('[contenteditable="true"]');
    if (editable) {
      await editable.click();
      await editable.fill('');
      await editable.type(html, { delay: 5 });
    } else {
      const frames = page.frames();
      for (const f of frames) {
        try {
          const body = await f.$('body');
          if (body) {
            await f.evaluate((h) => { document.body.innerHTML = h; }, html);
            break;
          }
        } catch (e) { /* ignore */ }
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
      const addBtn = await page.$('button:has-text("Add image"), button:has-text("Upload image"), button:has-text("Add media")');
      if (addBtn) {
        await addBtn.click();
        // If a URL input appears, paste the URL
        const urlInput = await page.$('input[placeholder*="http"], input[name="image_url"], input[aria-label*="image"]');
        if (urlInput) {
          await urlInput.fill(imgUrl);
          // Confirm insertion
          const ok = await page.$('button:has-text("Insert"), button:has-text("OK"), button:has-text("Upload"), button:has-text("Add")');
          if (ok) await ok.click();
          // small wait for UI to process
          await page.waitForTimeout(800);
          continue;
        }
      }

      // Fallback: try pasting image URL into any visible input fields
      const anyUrlInput = await page.$('input[type="url"], input[placeholder*="http"]');
      if (anyUrlInput) {
        await anyUrlInput.fill(imgUrl);
        await anyUrlInput.press('Enter');
        await page.waitForTimeout(800);
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
  const saveBtn = await page.$('button:has-text("Save"), button:has-text("Create"), button:has-text("Publish")');
  if (!saveBtn) throw new Error('Save button not found - update selector in script');
  await saveBtn.click();

  // Wait for success indicator
  await page.waitForTimeout(3000);
  const success = await page.$('text=Product created, text=Saved, text=Success');
  return !!success;
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

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Login to systeme.io
  const user = process.env.SYSTEME_USER;
  const pass = process.env.SYSTEME_PASS;
  if (!user || !pass) throw new Error('Missing SYSTEME_USER or SYSTEME_PASS env vars');

  await page.goto('https://app.systeme.io/login', { waitUntil: 'networkidle' });
  await page.fill('input[name="email"], input[type="email"]', user);
  await page.fill('input[name="password"], input[type="password"]', pass);
  await page.click('button:has-text("Log in"), button:has-text("Sign in")');
  await page.waitForLoadState('networkidle');

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
