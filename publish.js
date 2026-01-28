// publish.js
// HUSIN — Systeme.io physical product publisher (with variant support)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * Expected product shape (example):
 * {
 *   title: "Apple iPhone 15 Pro",
 *   description: "<p>Flagship device...</p>",
 *   sku: "IP15P-128-BLK",
 *   priceSar: 3799,
 *   weightGrams: 200,
 *   imageUrl: "https://...",
 *   options: [
 *     { name: "Size", values: ["S", "M", "L", "XL"] },
 *     { name: "Color", values: ["Black", "White", "Blue"] },
 *     { name: "Storage", values: ["128GB", "256GB", "512GB"] },
 *     { name: "Volume", values: ["50mm"] }
 *   ]
 * }
 */

// ---------- CONFIG ----------
const SYSTEME_BASE_URL = 'https://systeme.io';
const PRODUCT_CREATE_URL = `${SYSTEME_BASE_URL}/dashboard/products/create`;
const STORAGE_STATE_PATH = process.env.PLAYWRIGHT_STORAGE_STATE || 'storageState.json';
const PRODUCTS_JSON_PATH = process.env.PRODUCTS_JSON_PATH || 'products.json';
// ----------------------------

async function publishProduct(page, product) {
  console.log(`\nPublishing product: ${product.title}`);

  // 1. Go to product creation page
  await page.goto(PRODUCT_CREATE_URL, { waitUntil: 'networkidle' });

  // 2. Fill basic fields
  // Name
  await page.getByLabel('Name', { exact: true }).fill(product.title);

  // Description (fallback to plain text if HTML missing)
  const description = product.description || product.description_html || product.title;
  await page.getByLabel('Description', { exact: true }).fill(description);

  // SKU
  const sku =
    product.sku ||
    product.id ||
    product._id ||
    product.title.replace(/\s+/g, '-').toUpperCase().slice(0, 20);
  await page.getByLabel('SKU', { exact: true }).fill(sku);

  // Product tax = 0
  await page.getByLabel('Product tax', { exact: false }).fill('0');

  // Tax behavior = Exclusive (if present)
  const exclusiveRadio = page.getByLabel('Exclusive', { exact: true });
  if (await exclusiveRadio.isVisible().catch(() => false)) {
    await exclusiveRadio.check();
  }

  // Currency = Saudi Riyal (SAR)
  // Depending on Systeme.io, this might be a select with visible text "Saudi Riyal"
  const currencySelect = page.getByLabel('Currency', { exact: false });
  if (await currencySelect.isVisible().catch(() => false)) {
    try {
      await currencySelect.selectOption({ label: 'Saudi Riyal' });
    } catch {
      // Fallback: do nothing if already SAR
    }
  }

  // Main price (critical: must be >= 1)
  const priceValue = Math.max(1, Number(product.priceSar || product.price || 1));
  await page.getByLabel('Price', { exact: true }).fill(String(priceValue));

  // Weight (grams)
  const weightValue = Math.max(1, Number(product.weightGrams || product.weight || 100));
  const weightInput = page.getByLabel('Weight', { exact: false });
  if (await weightInput.isVisible().catch(() => false)) {
    await weightInput.fill(String(weightValue));
  }

  // Inventory (optional) — we’ll leave unlimited by default
  // Shipping — leave default (shipping enabled)

  // 3. Handle options / variants (if provided)
  if (Array.isArray(product.options) && product.options.length > 0) {
    console.log('Adding options / variants...');

    // Enable "This product has options" toggle
    const optionsToggle = page.getByText('This product has options', { exact: false });
    if (await optionsToggle.isVisible().catch(() => false)) {
      await optionsToggle.click();
    }

    // For each option group
    for (let i = 0; i < product.options.length; i++) {
      const opt = product.options[i];
      if (!opt || !opt.name || !Array.isArray(opt.values) || opt.values.length === 0) continue;

      // If not the first option, click "Add another option"
      if (i > 0) {
        const addOptionBtn = page.getByText('Add another option', { exact: false });
        if (await addOptionBtn.isVisible().catch(() => false)) {
          await addOptionBtn.click();
        }
      }

      // Locate the i-th option name input
      const optionNameInputs = page.locator('input').filter({ hasText: undefined });
      // We’ll use a more robust approach: find all "Option name" labels and index into them
      const optionNameLabel = page.getByText('Option name', { exact: false }).nth(i);
      await optionNameLabel.scrollIntoViewIfNeeded();
      const optionNameInput = optionNameLabel.locator('xpath=following::input[1]');
      await optionNameInput.fill(opt.name);

      // Now fill values
      // Systeme.io usually has one input per value with "Add another value" button
      for (let j = 0; j < opt.values.length; j++) {
        const value = opt.values[j];

        if (j === 0) {
          // First value goes into the first value input after this option block
          const firstValueInput = optionNameLabel.locator('xpath=following::input[1]');
          await firstValueInput.fill(value);
        } else {
          // Click "Add another value" then fill
          const addValueBtn = page.getByText('Add another value', { exact: false }).nth(i);
          if (await addValueBtn.isVisible().catch(() => false)) {
            await addValueBtn.click();
          }
          // After clicking, the last input in this option block should be the new value
          const valueInputs = optionNameLabel.locator('xpath=following::input');
          const count = await valueInputs.count();
          const lastValueInput = valueInputs.nth(count - 1);
          await lastValueInput.fill(value);
        }
      }
    }

    // After options are set, Systeme.io will auto-generate the variant matrix.
    // We DO NOT touch individual variant prices — they inherit the main price.
  } else {
    console.log('No options provided — publishing as simple product.');
  }

  // 4. Media (image) — optional, depends on your existing pipeline
  // If you already handle images elsewhere, you can skip this.
  // Otherwise, we can at least click "Select an image" and hope for a URL upload field.
  if (product.imageUrl) {
    try {
      const selectImageBtn = page.getByText('Select an image', { exact: false });
      if (await selectImageBtn.isVisible().catch(() => false)) {
        await selectImageBtn.click();
        // If Systeme.io supports URL-based upload, you’d handle it here.
        // Since we don’t know the exact modal structure, we leave this as a future extension.
      }
    } catch (e) {
      console.log('Image upload skipped (structure unknown).');
    }
  }

  // 5. Save product
  const saveButton = page.getByRole('button', { name: /Save|Create/i });
  await saveButton.click();

  // 6. Confirm success
  // We can wait for redirect to product list or a success toast.
  await page.waitForTimeout(3000);

  // Basic heuristic: check URL changed away from /products/create
  const currentUrl = page.url();
  if (!currentUrl.includes('/dashboard/products/create')) {
    console.log(`✅ Product "${product.title}" created successfully.`);
  } else {
    console.warn(`⚠ Product "${product.title}" may not have been created (still on create page).`);
  }
}

async function main() {
  // Load products from JSON (your pipeline already prepares this)
  const productsPath = path.resolve(PRODUCTS_JSON_PATH);
  if (!fs.existsSync(productsPath)) {
    console.error(`Products file not found: ${productsPath}`);
    process.exit(1);
  }

  const products = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
  if (!Array.isArray(products) || products.length === 0) {
    console.error('No products found in products.json');
    process.exit(1);
  }

  // Launch browser with stored session
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
  });
  const page = await context.newPage();

  console.log(`Loaded ${products.length} products. Starting publishing...`);

  for (const product of products) {
    try {
      await publishProduct(page, product);
    } catch (err) {
      console.error(`❌ Error publishing "${product.title}":`, err.message || err);
      // Optional: take screenshot for debugging
      try {
        const safeTitle = (product.title || 'product').replace(/[^a-z0-9]/gi, '_').slice(0, 40);
        await page.screenshot({ path: `error-${safeTitle}.png`, fullPage: true });
      } catch {}
    }
  }

  await browser.close();
  console.log('Publishing run completed.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error in publish.js:', err);
    process.exit(1);
  });
}

module.exports = { publishProduct };
