// POST /api/webhooks/square
// Square calls this the instant inventory or catalog changes — e.g. you sell the
// last size L in-store, or edit a price in the Square dashboard. Verify the
// signature, then bust your product cache (if you added one to products.js) so
// the very next storefront page load reflects it. Without any cache, products.js
// already reads Square live on every request, so this webhook is optional but
// recommended once traffic grows (see the caching note at the bottom of products.js).

const crypto = require('crypto');

const SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
const NOTIFICATION_URL = process.env.SQUARE_WEBHOOK_URL; // exact URL you registered in Square, e.g. https://rebelreaper.com/api/webhooks/square

function isValidSignature(rawBody, signatureHeader) {
  if (!SIGNATURE_KEY || !NOTIFICATION_URL) return false;
  const hmac = crypto.createHmac('sha256', SIGNATURE_KEY);
  hmac.update(NOTIFICATION_URL + rawBody);
  const expected = hmac.digest('base64');
  return expected === signatureHeader;
}

module.exports = async (req, res) => {
  const signature = req.headers['x-square-hmacsha256-signature'];
  const rawBody = JSON.stringify(req.body); // if you can, verify against the true raw body before JSON parsing

  if (!isValidSignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  switch (event.type) {
    case 'inventory.count.updated':
    case 'catalog.version.updated':
      // TODO once you add caching to products.js: invalidate/refresh the cache here.
      console.log('Square catalog/inventory changed — cache invalidation would run here', event.type);
      break;
    case 'payment.updated':
      console.log('Payment status changed', event.data?.id);
      break;
    default:
      console.log('Unhandled Square webhook event', event.type);
  }

  res.status(200).json({ received: true });
};
