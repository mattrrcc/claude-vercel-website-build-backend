// POST /api/checkout
// Body: { sourceId, items: [{id, size, qty}], shipMethod, buyerEmail }
// `sourceId` is the payment token produced client-side by Square's Web Payments SDK
// (card, Apple Pay, or Afterpay/Cash App — the SDK returns the same token shape for
// all three). This is the ONLY place your Square access token is ever used for
// money movement, and it never leaves the server.

const square = require('square');
const SquareClient = square.SquareClient || (square.default && square.default.SquareClient);
const { randomUUID } = require('crypto');

const client = new SquareClient({
    token: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENV === 'production'
          ? 'https://connect.squareup.com'
          : 'https://connect.squareupsandbox.com',
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
      const obj = await client.catalog.object.get({ objectId: line.id });
      const variation = obj.object?.itemVariationData || obj.data?.itemVariationData;
      return {
        name: obj.object?.itemData?.name || line.id,
        qty: line.qty,
        amount: Number(variation?.priceMoney?.amount || 0),
      };
    }));

    const subtotalCents = priced.reduce((s, l) => s + l.amount * l.qty, 0);
    const shippingCents = shipMethod === 'express' ? SHIPPING_FLAT_RATE_CENTS : 0;
    const totalCents = subtotalCents + shippingCents;

    const payment = await client.payments.create({
      sourceId,
      idempotencyKey: randomUUID(),
      amountMoney: { amount: totalCents, currency: 'USD' },
      locationId: LOCATION_ID,
      buyerEmailAddress: buyerEmail || undefined,
      note: `rebelreaper.com order — ${priced.map(p => `${p.qty}x ${p.name}`).join(', ')}`,
    });

    // Optional: also create a Square Order so it shows in Square's Orders dashboard
    // with line items (not just a raw Payment). See README "Orders API" note.

    res.status(200).json({
      success: true,
      paymentId: payment.payment?.id,
      receiptUrl: payment.payment?.receiptUrl,
      totalCents,
    });
  } catch (err) {
          if (err && (Array.isArray(err.errors) || err.statusCode)) {
      console.error('Square payment error', err.errors);
      return res.status(402).json({ error: 'Payment failed', detail: err.errors });
    }
    console.error('checkout.js error', err);
    res.status(500).json({ error: 'Checkout failed', detail: String(err.message || err) });
  }
};
