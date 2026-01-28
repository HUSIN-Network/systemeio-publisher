// publish.cjs — HUSIN Production Publisher (Variants + Telegram + Logging)

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// -------------------------
// ENVIRONMENT VARIABLES
// -------------------------
const STORAGE_STATE_PATH = process.env.PLAYWRIGHT_STORAGE_STATE || "storageState.json";
const PRODUCTS_JSON_PATH = process.env.PRODUCTS_JSON_PATH || "products.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PRODUCT_CREATE_URL = "https://systeme.io/dashboard/products/create";

// -------------------------
// TELEGRAM HELPERS
// -------------------------
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }
    );
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

// -------------------------
// MAIN PUBLISH FUNCTION
// -------------------------
async function publishProduct(page, product) {
  const productId = product.id || product._id || "NO_ID";
  const title = product.title || "NO_TITLE";

  console.log(`\n🟦 Publishing product: [${productId}] ${title}`);
  await sendTelegram(`🚀 Publishing started for <b>${title}</b> (ID: <code>${productId}</code>)`);

  try {
    // 1. Open product creation page
    await page.goto(PRODUCT_CREATE_URL, { waitUntil: "networkidle" });

    // 2. Fill basic fields
    await page.getByLabel("Name", { exact: true }).fill(title);

    const description =
      product.description_html ||
      product.description ||
      `<p>${title}</p>`;
    await page.getByLabel("Description", { exact: true }).fill(description);

    const sku =
      product.sku ||
      productId ||
      title.replace(/\s+/g, "-").toUpperCase().slice(0, 20);
    await page.getByLabel("SKU", { exact: true }).fill(sku);

    await page.getByLabel("Product tax").fill("0");

    const exclusiveRadio = page.getByLabel("Exclusive");
    if (await exclusiveRadio.isVisible().catch(() => false)) {
      await exclusiveRadio.check();
    }

    const priceSar = Math.max(1, Number(product.priceSar || product.price || 1));
    await page.getByLabel("Price", { exact: true }).fill(String(priceSar));

    const weight = Math.max(1, Number(product.weightGrams || product.weight || 100));
    const weightInput = page.getByLabel("Weight", { exact: false });
    if (await weightInput.isVisible().catch(() => false)) {
      await weightInput.fill(String(weight));
    }

    // 3. Variants
    if (Array.isArray(product.options) && product.options.length > 0) {
      console.log("🟩 Adding variants...");

      const toggle = page.getByText("This product has options", { exact: false });
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click();
      }

      for (let i = 0; i < product.options.length; i++) {
        const opt = product.options[i];

        if (i > 0) {
          const addOptionBtn = page.getByText("Add another option", { exact: false });
          if (await addOptionBtn.isVisible().catch(() => false)) {
            await addOptionBtn.click();
          }
        }

        const optionNameLabel = page.getByText("Option name", { exact: false }).nth(i);
        const optionNameInput = optionNameLabel.locator("xpath=following::input[1]");
        await optionNameInput.fill(opt.name);

        for (let j = 0; j < opt.values.length; j++) {
          const value = opt.values[j];

          if (j === 0) {
            const firstValueInput = optionNameLabel.locator("xpath=following::input[1]");
            await firstValueInput.fill(value);
          } else {
            const addValueBtn = page.getByText("Add another value", { exact: false }).nth(i);
            if (await addValueBtn.isVisible().catch(() => false)) {
              await addValueBtn.click();
            }

            const valueInputs = optionNameLabel.locator("xpath=following::input");
            const count = await valueInputs.count();
            await valueInputs.nth(count - 1).fill(value);
          }
        }
      }
    }

    // 4. Save product
    const saveBtn = page.getByRole("button", { name: /Save|Create/i });
    await saveBtn.click();

    // 5. Confirm success + extract product URL
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const productCreated = !finalUrl.includes("/dashboard/products/create");

    if (productCreated) {
      console.log(`✅ SUCCESS: [${productId}] ${title}`);
      console.log(`🔗 Product URL: ${finalUrl}`);

      await sendTelegram(
        `✅ <b>SUCCESS</b>\n` +
        `Product: <b>${title}</b>\n` +
        `ID: <code>${productId}</code>\n` +
        `URL: <a href="${finalUrl}">${finalUrl}</a>`
      );
    } else {
      throw new Error("Systeme.io did not redirect — product may not be saved.");
    }

  } catch (err) {
    console.error(`❌ FAILED: [${productId}] ${title}`, err.message);

    await sendTelegram(
      `❌ <b>FAILED</b>\nProduct: <b>${title}</b>\nID: <code>${productId}</code>\nError: <code>${err.message}</code>`
    );

    const safe = title.replace(/[^a-z0-9]/gi, "_").slice(0, 40);
    await page.screenshot({ path: `error-${safe}.png`, fullPage: true });
  }
}

// -------------------------
// MAIN EXECUTION
// -------------------------
async function main() {
  const productsPath = path.resolve(PRODUCTS_JSON_PATH);
  if (!fs.existsSync(productsPath)) {
    console.error("products.json not found");
    process.exit(1);
  }

  const products = JSON.parse(fs.readFileSync(productsPath, "utf8"));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const page = await context.newPage();

  console.log(`\nLoaded ${products.length} products.`);

  for (const product of products) {
    await publishProduct(page, product);
  }

  await browser.close();
  console.log("\n🎉 Publishing complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
