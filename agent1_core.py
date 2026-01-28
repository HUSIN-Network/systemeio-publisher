import os
import json
import time
import requests
from dotenv import load_dotenv

from firestore_client import FirestoreClient
import shop_renderer

load_dotenv()

APP_ID = os.getenv("APP_ID", "husin-network")
SERVICE_ACCOUNT_PATH = os.getenv(
    "SERVICE_ACCOUNT_PATH",
    "/home/HUSINPY/Husin_Network/Keys/service_account.json"
)

SYSTEME_API_KEY = os.getenv("SYSTEME_API_KEY")
SYSTEME_API_BASE = os.getenv("SYSTEME_API_BASE", "https://api.systeme.io")

SYSTEME_WEBSITE_ID = os.getenv("SYSTEME_WEBSITE_ID")
SYSTEME_HOME_PAGE_ID = os.getenv("SYSTEME_HOME_PAGE_ID")
SYSTEME_CATEGORIES_PAGE_ID = os.getenv("SYSTEME_CATEGORIES_PAGE_ID")
SYSTEME_CATEGORY_TEMPLATE_ID = os.getenv("SYSTEME_CATEGORY_TEMPLATE_ID")
SYSTEME_PRODUCTS_PAGE_ID = os.getenv("SYSTEME_PRODUCTS_PAGE_ID")
SYSTEME_PRODUCT_TEMPLATE_ID = os.getenv("SYSTEME_PRODUCT_TEMPLATE_ID")
SYSTEME_BUNDLES_PAGE_ID = os.getenv("SYSTEME_BUNDLES_PAGE_ID")
SYSTEME_BUNDLE_TEMPLATE_ID = os.getenv("SYSTEME_BUNDLE_TEMPLATE_ID")
SYSTEME_SEARCH_PAGE_ID = os.getenv("SYSTEME_SEARCH_PAGE_ID")
SYSTEME_CONTACT_PAGE_ID = os.getenv("SYSTEME_CONTACT_PAGE_ID")
SYSTEME_TERMS_PAGE_ID = os.getenv("SYSTEME_TERMS_PAGE_ID")
SYSTEME_PRIVACY_PAGE_ID = os.getenv("SYSTEME_PRIVACY_PAGE_ID")

if not SYSTEME_API_KEY or not SYSTEME_WEBSITE_ID:
    raise RuntimeError("Systeme.io env vars missing")

_db = FirestoreClient(SERVICE_ACCOUNT_PATH).db


def _systeme_headers():
    return {
        "Content-Type": "application/json",
        "X-API-Key": SYSTEME_API_KEY,
    }


def _update_page(page_id: str, html: str):
    if not page_id:
        print(f"[AGENT 01] Skipping page update (no page_id).")
        return

    url = f"{SYSTEME_API_BASE}/sites/{SYSTEME_WEBSITE_ID}/pages/{page_id}"
    payload = {
        "content": html
    }

    try:
        resp = requests.put(url, headers=_systeme_headers(), data=json.dumps(payload), timeout=60)
        if resp.status_code >= 200 and resp.status_code < 300:
            print(f"[AGENT 01] Updated page {page_id} successfully.")
        else:
            print(f"[AGENT 01] Failed to update page {page_id}. Status: {resp.status_code}, Body: {resp.text}")
    except Exception as e:
        print(f"[AGENT 01] ERROR updating page {page_id}: {e}")


def _build_home_page_html() -> str:
    featured_categories_html = shop_renderer.get_featured_categories_html()
    featured_products_html = shop_renderer.get_featured_products_html()
    featured_bundles_html = shop_renderer.get_featured_bundles_html()

    html = f"""
<div class="husin-home">
  <section class="hero">
    <h1>HUSIN — Curated Deals in Saudi Arabia</h1>
    <p>Exclusive products, hot offers, and premium bundles. All prices in Saudi Riyal (SAR).</p>
  </section>

  <section class="section-block">
    <h2>Featured Categories</h2>
    <div class="card-grid">
      {featured_categories_html}
    </div>
  </section>

  <section class="section-block">
    <h2>Featured Products</h2>
    <div class="card-grid">
      {featured_products_html}
    </div>
  </section>

  <section class="section-block">
    <h2>Featured Bundles</h2>
    <div class="card-grid">
      {featured_bundles_html}
    </div>
  </section>
</div>
"""
    return html


def _build_categories_page_html() -> str:
    categories_html = shop_renderer.get_all_categories_html()
    html = f"""
<div class="husin-categories">
  <h1>All Categories</h1>
  <div class="card-grid">
    {categories_html}
  </div>
</div>
"""
    return html


def _build_products_page_html() -> str:
    # This can be a generic intro; actual product pages use the template.
    html = """
<div class="husin-products">
  <h1>Our Products</h1>
  <p>Browse curated products approved by HUSIN for quality, margin, and reliability.</p>
</div>
"""
    return html


def _build_bundles_page_html() -> str:
    bundles_html = shop_renderer.get_bundles_page_html()
    html = f"""
<div class="husin-bundles">
  <h1>Bundles</h1>
  <p>Save more with curated product bundles.</p>
  <div class="card-grid">
    {bundles_html}
  </div>
</div>
"""
    return html


def _build_search_page_html() -> str:
    # Systeme.io will inject the search query; we just provide container.
    html = """
<div class="husin-search">
  <h1>Search Results</h1>
  <div id="husin-search-results">
    <!-- Agent 1 renders search results server-side if needed -->
  </div>
</div>
"""
    return html


def _build_static_page_html(title: str, body: str) -> str:
    return f"""
<div class="husin-static">
  <h1>{title}</h1>
  <p>{body}</p>
</div>
"""


def publish_all():
    print(">> [AGENT 01] Publishing approved content to Systeme.io...")

    # Home
    home_html = _build_home_page_html()
    _update_page(SYSTEME_HOME_PAGE_ID, home_html)

    # Categories
    categories_html = _build_categories_page_html()
    _update_page(SYSTEME_CATEGORIES_PAGE_ID, categories_html)

    # Products index page
    products_html = _build_products_page_html()
    _update_page(SYSTEME_PRODUCTS_PAGE_ID, products_html)

    # Bundles index page
    bundles_html = _build_bundles_page_html()
    _update_page(SYSTEME_BUNDLES_PAGE_ID, bundles_html)

    # Search page
    search_html = _build_search_page_html()
    _update_page(SYSTEME_SEARCH_PAGE_ID, search_html)

    # Static pages (optional simple content)
    if SYSTEME_CONTACT_PAGE_ID:
        contact_html = _build_static_page_html(
            "Contact",
            "For inquiries, please reach out via the contact form on this page."
        )
        _update_page(SYSTEME_CONTACT_PAGE_ID, contact_html)

    if SYSTEME_TERMS_PAGE_ID:
        terms_html = _build_static_page_html(
            "Terms & Conditions",
            "These are the terms and conditions for using HUSIN services."
        )
        _update_page(SYSTEME_TERMS_PAGE_ID, terms_html)

    if SYSTEME_PRIVACY_PAGE_ID:
        privacy_html = _build_static_page_html(
            "Privacy Policy",
            "We respect your privacy and handle your data with care."
        )
        _update_page(SYSTEME_PRIVACY_PAGE_ID, privacy_html)

    print(">> [AGENT 01] Publish cycle complete.")


if __name__ == "__main__":
    start = time.time()
    print(">> [HUSIN] AGENT 01 (PUBLISHER) STARTED...")
    publish_all()
    elapsed = time.time() - start
    print(f">> [HUSIN] AGENT 01 (PUBLISHER) FINISHED in {elapsed:.2f}s.")
