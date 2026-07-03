// GET /api/products
// Reads live catalog + inventory counts straight from Square and returns them in
// the exact shape the storefront's store.js already expects.
//
// NOTE: the installed `square` npm package resolves to its LEGACY SDK shape when
// loaded via require() (Client/Environment + camelCase "xxxApi" resources, e.g.
// client.catalogApi, client.inventoryApi) rather than the newer SquareClient
// resource shape shown in some docs. This file is written against that shape.

const { Client, Environment } = require('square');

const client = new Client({
          environment: process.env.SQUARE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
          bearerAuthCredentials: {
                      accessToken: process.env.SQUARE_ACCESS_TOKEN,
          },
});

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

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
                      const catResp = await client.catalogApi.listCatalog(undefined, 'CATEGORY');
                      const categoryNameById = {};
                      for (const obj of catResp.result.objects || []) {
                                    categoryNameById[obj.id] = obj.categoryData?.name;
                      }

            let items = [];
                      let cursor;
                      do {
                                    const page = await client.catalogApi.listCatalog(cursor, 'ITEM');
                                    items = items.concat(page.result.objects || []);
                                    cursor = page.result.cursor;
                      } while (cursor);

            const variationIds = [];
                      for (const item of items) {
                                    for (const v of item.itemData?.variations || []) variationIds.push(v.id);
                      }
                      let countsByVariation = {};
                      if (variationIds.length) {
                                    const invResp = await client.inventoryApi.batchRetrieveInventoryCounts({
                                                    catalogObjectIds: variationIds,
                                                    locationIds: LOCATION_ID ? [LOCATION_ID] : undefined,
                                    });
                                    for (const count of invResp.result.counts || []) {
                                                    const existing = countsByVariation[count.catalogObjectId] || 0;
                                                    countsByVariation[count.catalogObjectId] = existing + Number(count.quantity || 0);
                                    }
                      }

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
                                                       tone: 'hsl(0,0%,9%)',
                                                       swatches: ['#1a1a1a'],
                                                       sizes: sizes.length ? sizes : ['One Size'],
                                                       rating: 4.8,
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
