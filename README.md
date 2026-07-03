# Rebel Reaper — Live Backend (Square-powered)

## What this is
The storefront (the `.dc.html` files one level up) is the customer-facing frontend —
it's finished and already pulls real Square catalog data on first load. This folder
is the missing piece that makes it a **real, live, transacting website**: a small
backend that holds your Square access token and talks to Square on the frontend's
behalf. It cannot live in the frontend files — Square's payment/inventory APIs
require a secret key that must never touch a customer's browser.

Once deployed, nothing else changes: `store.js` already calls `/api/products` and
`/api/checkout` first and only falls back to its static snapshot if those don't
exist yet. Deploy this folder and the same frontend goes live automatically.

## What it does
- `api/products.js` — reads your live Square Catalog + Inventory on every request
  and returns it in the shape the frontend expects. Edit a price or size in Square →
  it's correct on the site within the minute (see caching note in that file).
- `api/checkout.js` — takes a payment token from Square's Web Payments SDK (card,
  Apple Pay, or Afterpay all produce the same token shape) and charges it through
  your real Square account via the Payments API. Prices are re-verified server-side
  against Square — the browser is never trusted with the final total.
- `api/webhooks/square.js` — receives push notifications the instant inventory or
  catalog data changes in Square, so you can invalidate a cache immediately instead
  of waiting on the next request (optional at your current traffic level).

Your customers, inventory, and marketing (Klaviyo/Postscript per your design
system) keep living entirely in Square's dashboard — this backend only reads and
writes through Square's API, nothing is duplicated into a second database.

## Fastest path to live: deploy to Vercel (free tier is enough to start)

1. **Get your Square credentials** (developer.squareup.com → your app):
   - Production access token (Square dashboard → this app → Credentials)
   - Location ID (Square dashboard → Account & Settings → Locations)
   - Keep these secret — never commit them to git.

2. **Push this `backend/` folder to its own GitHub repo** (or a `backend/` folder in
   your existing repo — Vercel can deploy a subfolder).

3. **Import the repo at vercel.com** → New Project → set the root directory to
   `backend/` if it's part of a bigger repo.

4. **Add environment variables** in the Vercel project settings:
   - `SQUARE_ACCESS_TOKEN` — production token from step 1
   - `SQUARE_LOCATION_ID` — from step 1
   - `SQUARE_ENV` = `production`
   - `SQUARE_WEBHOOK_SIGNATURE_KEY` — created in step 6 below
   - `SQUARE_WEBHOOK_URL` — `https://rebelreaper.com/api/webhooks/square`

5. **Deploy.** Vercel gives you a URL like `rebel-reaper-backend.vercel.app` —
   confirm `https://<that-url>/api/products` returns real JSON before moving on.

6. **Create the Square webhook subscription** (developer.squareup.com → your app →
   Webhooks): subscribe to `inventory.count.updated` and `catalog.version.updated`,
   point it at `https://rebelreaper.com/api/webhooks/square`, copy the generated
   signature key into the Vercel env var from step 4.

## Wiring your GoDaddy domain (rebelreaper.com)

You do **not** move the domain off GoDaddy — it stays your registrar, you just
point its DNS at your new hosting:

1. **Frontend** (the `.dc.html` storefront): host it wherever it currently
   lives, or also on Vercel/Netlify/Cloudflare Pages as a static site.
   - GoDaddy DNS → add a CNAME record: `www` → `cname.vercel-dns.com` (or your
     chosen host's target)
   - Add an A record for the bare domain `@` → the IP your host provides (Vercel
     shows this in the domain setup screen)
2. **Backend**: if deployed as its own Vercel project, either
   - put it on a subdomain, e.g. `api.rebelreaper.com` (CNAME → Vercel), and set
     the frontend to call `https://api.rebelreaper.com/api/products`, **or**
   - deploy frontend + backend as one Vercel project (frontend as static files,
     `backend/api` as its serverless functions) so both share `rebelreaper.com`
     and the existing `/api/products` calls need no URL changes at all — simplest option.
3. Vercel/Netlify auto-provision free SSL (Let's Encrypt) once DNS resolves —
   no separate certificate purchase needed.
4. Point Square's Apple Pay domain verification (below) and the webhook URL at
   the final `rebelreaper.com` domain once DNS is live.

## Turning on card, Apple Pay, and Afterpay in checkout

The backend is ready for all three — the frontend still needs Square's **Web
Payments SDK** wired into the checkout form (currently a static mockup). Outline:

```html
<script src="https://web.squarecdn.com/v1/square.js"></script>
<script>
  const payments = Square.payments(APPLICATION_ID, LOCATION_ID);
  const card = await payments.card();
  await card.attach('#card-container');

  const applePay = await payments.applePay(await payments.paymentRequest({...}));
  const afterpay = await payments.afterpayClearpay(await payments.paymentRequest({...}));

  async function pay(paymentMethod) {
    const result = await paymentMethod.tokenize();
    if (result.status === 'OK') {
      await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: result.token, items: cart, shipMethod }),
      });
    }
  }
</script>
```

Square-side setup for this:
- **Apple Pay**: developer.squareup.com → Apple Pay → verify domain
  `rebelreaper.com` (Square gives you a file to host at
  `/.well-known/apple-developer-merchantid-domain-association`)
- **Afterpay/Clearpay**: enabled automatically for eligible US sellers in your
  Square dashboard under Payment Methods — no extra keys needed, the Web
  Payments SDK handles it once `afterpayClearpay()` is called
- **Cards**: work immediately with just the access token, no extra setup

I can wire this exact SDK code into `Checkout.dc.html` for you once you've
deployed the backend and have your Application ID + Location ID handy — it's a
quick follow-up, not a rebuild.

## Also consider: Square Orders API
Right now `checkout.js` creates a Square **Payment** directly. For orders to show
up in Square's Orders tab with line items (not just a raw charge), create a
Square **Order** first via `client.orders.create()`, then pass its `order_id`
into `payments.create()`. Happy to add this if you want orders to appear
line-item-by-line-item in your Square dashboard exactly like an in-person sale.

## Alternatives if you'd rather not run a backend at all
- **Square Online** — Square's own site builder, perfect native sync, zero
  backend, but you lose this custom design.
- **Square Checkout Links / Buy Button** embedded in this design — no backend,
  but customers leave this site for a Square-hosted payment page.
