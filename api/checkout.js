// POST /api/checkout
// Body: { sourceId, items: [{id, size, qty}], shipMethod, buyerEmail }
// `sourceId` is the payment token produced client-side by Square's Web Payments SDK
// (card, Apple Pay, or Afterpay/Cash App — the SDK returns the same token shape for
// all three). This is the ONLY place your Square access token is ever used for
// money movement, and it never leaves the server.
//
// NOTE: the installed `square` npm package resolves to its LEGACY SDK shape when
// loaded via require() (Client/Environment + camelCase "xxxApi" resources), not
// the newer SquareClient resource shape. This file is written against that shape.

const { Client, Environment, ApiError } = require('square');
const { randomUUID } = require('crypto');

const client = new Client({
      environment: process.env.SQUARE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
      bearerAuthCredentials: {
              accessToken: process.env.SQUARE_ACCESS_TOKEN,
      },
});

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SHIPPING_FLAT_RATE_CENTS = 1500; // Express shipping; standard is free — mirrors Checkout.dc.html

module.exports = async (req, res) => {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

      try {
              const { sourceId, items, shipMethod, buyerEmail } = req.body;
              if (!sourceId) return res.status(400).json({ error: 'Missing sourceId (payment token from Web Payments SDK)' });
              if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

        // Re-price server-side from Square's live catalog — never trust client-sent prices.
        const priced = await Promise.all(items.map(async (line) => {
                  const objResp = await client.catalogApi.retrieveCatalogObject(line.id);
                  const obj = objResp.result.object;
                  const variation = obj?.itemVariationData;
                  return {
                              name: obj?.itemData?.name || line.id,
                              qty: line.qty,
                              amount: Number(variation?.priceMoney?.amount || 0),
                  };
        }));

        const subtotalCents = priced.reduce((s, l) => s + l.amount * l.qty, 0);
              const shippingCents = shipMethod === 'express' ? SHIPPING_FLAT_RATE_CENTS : 0;
              const totalCents = subtotalCents + shippingCents;

        const paymentResp = await client.paymentsApi.createPayment({
                  sourceId,
                  idempotencyKey: randomUUID(),
                  amountMoney: { amount: BigInt(totalCents), currency: 'USD' },
                  locationId: LOCATION_ID,
                  buyerEmailAddress: buyerEmail || undefined,
                  note: `rebelreaper.com order — ${priced.map(p => `${p.qty}x ${p.name}`).join(', ')}`,
        });

        const payment = paymentResp.result.payment;

        res.status(200).json({
                  success: true,
                  paymentId: payment?.id,
                  receiptUrl: payment?.receiptUrl,
                  totalCents,
        });
      } catch (err) {
              if (err instanceof ApiError) {
                        console.error('Square payment error', err.result);
                        return res.status(402).json({ error: 'Payment failed', detail: err.result });
              }
              console.error('checkout.js error', err);
              res.status(500).json({ error: 'Checkout failed', detail: String(err.message || err) });
      }
};
