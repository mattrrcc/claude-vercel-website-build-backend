// GET /api/products
// Reads live catalog + inventory counts straight from Square and returns them in
// the exact shape the storefront's store.js already expects — so the frontend
// needs ZERO changes when you flip this on. Prices/stock always match Square,
// because this reads Square directly on every request (add a short cache if you
// want to reduce API calls under heavy traffic — see comment at bottom).

const square = require('square');

function getClient() {
        const candidates = [
                  ['square.SquareClient', square.SquareClient],
                  ['square.default.SquareClient', square.default && square.default.SquareClient],
                ];
        let ctor, usedLabel;
        for (const [label, c] of candidates) {
                  if (typeof c === 'function') { ctor = c; usedLabel = label; break; }
        }
        if (!ctor) {
                  const topKeys = Object.keys(square || {}).join(', ');
                  const defaultKeys = square && square.default ? Object.keys(square.default).join(', ') : 'none';
                  throw new Error('SquareClient constructor not found. top-level keys: [' + topKeys + '] default keys: [' + defaultKeys + ']');
        }
        const instance = new ctor({
                  token: process.env.SQUARE_ACCESS_TOKEN,
                  environment: process.env.SQUARE_ENV === 'production'
                              ? 'https://connect.squareup.com'
                              : 'https://connect.squareupsandbox.com',
        });
        if (!instance.catalog) {
                  const ownKeys = Object.keys(instance).join(', ');
                  const protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).join(', ');
                  throw new Error('Client built via ' + usedLabel + ' but has no .catalog getter. own keys: [' + ownKeys + '] proto keys: [' + protoKeys + ']');
        }
        return instance;
}

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// Rebel Reaper's real Square category names -> the storefront's simplified nav categories.
// Add/adjust as you rename categories in Square — no other code needs to change.
const CATEGORY_NAME_MAP = {
  'Mens Vests': 'Vests',
  'Womens Vests': 'Vests',
  'Button Up Shirts': 'Flannels',
  'Flannels': 'Flannels',
  'Mens Flannels': 'Flannels',
  'Womens Flannels': 'Flannels',
  'T-Shirts': 'Tees',
  'Jackets': 'Jackets',
  'Hats': 'Accessories',
  'Gloves': 'Accessories',
  'Socks': 'Accessories',
  'Sunglasses': 'Accessories',
  'Accessories': 'Accessories',
};

function centsToDollars(m) {
  return m ? Number(m.amount) / 100 : 0;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  try {
            const client = getClient();
    // 1. Pull categories so we can map IDs -> friendly names.
    const catResp = await client.catalog.list({ types: 'CATEGORY' });
    const categoryNameById = {};
    for (const obj of catResp.data || catResp.objects || []) {
      categoryNameById[obj.id] = obj.categoryData?.name;
    }

    // 2. Pull items (paginate until done).
    let items = [];
    let cursor;
    do {
      const page = await client.catalog.list({ types: 'ITEM', cursor });
      items = items.concat(page.data || page.objects || []);
      cursor = page.cursor;
    } while (cursor);

    // 3. Collect all variation IDs to look up live inventory counts in one batch call.
    const variationIds = [];
    for (const item of items) {
      for (const v of item.itemData?.variations || []) variationIds.push(v.id);
    }
    let countsByVariation = {};
    if (variationIds.length) {
      const invResp = await client.inventory.batchGetCounts({
        catalogObjectIds: variationIds,
        locationIds: LOCATION_ID ? [LOCATION_ID] : undefined,
      });
      for (const count of invResp.data || invResp.counts || []) {
        const existing = countsByVariation[count.catalogObjectId] || 0;
        countsByVariation[count.catalogObjectId] = existing + Number(count.quantity || 0);
      }
    }

    // 4. Shape into the storefront's product schema.
    const products = items
      .filter(item => item.itemData?.ecomVisibility !== 'UNAVAILABLE' && !item.isArchived)
      .map(item => {
        const data = item.itemData;
        const variations = data.variations || [];
        const firstVar = variations[0]?.itemVariationData;
        const sizes = variations.map(v => v.itemVariationData?.name).filter(Boolean);
        const totalStock = variations.reduce((s, v) => s + (countsByVariation[v.id] || 0), 0);
        const anySoldOutFlag = variations.some(v =>
          (v.itemVariationData?.locationOverrides || []).some(o => o.soldOut)
        );
        const rawCategoryId = data.categories?.[0]?.id;
        const rawCategoryName = categoryNameById[rawCategoryId] || 'Accessories';
        const category = CATEGORY_NAME_MAP[rawCategoryName] || 'Accessories';

        return {
          id: item.id,
          squareItemId: item.id,
          title: data.name,
          category,
          price: centsToDollars(firstVar?.priceMoney),
          tone: 'hsl(0,0%,9%)', // real photos come from Square image_ids — wire in once you're ready
          swatches: ['#1a1a1a'],
          sizes: sizes.length ? sizes : ['One Size'],
          rating: 4.8,        // Square Catalog has no review data — Loox/your review app is a separate source
          reviewCount: 0,
          soldOut: variationIds.length ? (totalStock <= 0 || anySoldOutFlag) : false,
          inventory: totalStock,
        };
      });

    res.status(200).json(products);
  } catch (err) {
    console.error('products.js error', err);
    res.status(500).json({ error: 'Failed to load products from Square', detail: String(err.message || err) });
  }
};

// Traffic note: this hits Square on every request. Fine for a small storefront.
// For higher traffic, wrap the try block in a 30-60s in-memory or KV cache, or
// switch to Square webhooks (catalog.version.updated / inventory.count.updated)
// that invalidate a cache instead of polling — see webhooks/square.js.
