# diced — AI estimate setup

Lets the "✨ Don't know the calories?" button in Add Food work. It's optional —
diced works fully without it, this just adds one feature.

**Why this needs a few minutes of setup instead of just working:** getting an
AI to estimate a food means calling a model API, which means an API key. A
key can never live in diced's own code — it's a public repo, so anyone could
read it out and use it. Instead, this Worker holds your key privately and
diced talks to the Worker, never to the API directly.

**Cost: $0.** Cloudflare Workers' free tier (100,000 requests/day) and
Google's Gemini API free tier (no credit card, no billing enabled at all —
just a usage cap per minute/day that's far above personal-use levels) both
cover this comfortably. There is nothing to pay and nothing to set a spending
cap on.

## 1. Get a free Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   and sign in with any Google account.
2. Click **Create API key**. No billing or credit card is involved — this is
   the free tier.
3. Copy the key somewhere safe for a moment — you'll paste it in step 3.

## 2. Create the Worker (connected to GitHub)

This repo includes `worker/wrangler.toml`, Cloudflare's config file, so a
Git-connected Worker auto-redeploys whenever `worker.js` changes here —
no manual copy-paste each time the AI prompt gets tweaked.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com), sign up or sign
   in (free, no card required for this tier).
2. In the sidebar: **Workers & Pages → Create**.
3. Click **Connect GitHub**, authorize Cloudflare's GitHub app, and give it
   access to the `diced` repo (just that one repo, not all of them).
4. Select the `diced` repository.
5. Set **Root directory** to `worker` — this tells Cloudflare to only look
   inside the `worker/` folder (so your diet data in `index.html` etc. is
   never touched by this).
6. Cloudflare should auto-detect `wrangler.toml` and fill in the build
   settings. Leave the build command empty (there's nothing to build) and
   deploy.
7. Note the Worker's URL shown on its page, something like
   `https://diced-estimate.yourname.workers.dev`.

## 3. Set your two secrets

Secrets are never stored in the repo or in `wrangler.toml` — set them
directly on the Worker, once, in the dashboard: that Worker's page →
**Settings → Variables and Secrets → Add**.

Add two, both as **Secret** (not plain text) so they're encrypted:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | the key you copied in step 1 |
| `APP_SECRET` | any random string you make up — this is a shared password between diced and your Worker so random internet traffic can't use your API key. A password generator's output works fine. |

Save/Deploy after adding both. These survive future auto-redeploys from
GitHub — you only set them this once.

## 4. Plug it into diced

1. Open diced on your phone → **Plan** tab → **AI estimate** card.
2. **Worker URL**: paste the Worker's URL from step 2.7.
3. **App secret**: paste the exact same string you set as `APP_SECRET` in
   step 3.
4. **Save**.

Try it: Today → **+ Add food** → **✨ Don't know the calories?** → type
something simple like "an orange" → Estimate.

## If something's not working

- **"The app secret doesn't match..."** — the value in diced's Plan tab and
  the Worker's `APP_SECRET` variable have to be character-for-character
  identical. Re-copy both.
- **"Your Worker isn't allowing requests from this app's address"** — the
  Worker only accepts requests from `https://viz248.github.io`. If you forked
  this repo or deployed Pages under a different GitHub username, edit
  `ALLOWED_ORIGIN` at the top of `worker.js` to match your actual Pages URL,
  then redeploy the Worker (paste the updated code in again).
- **"Your Worker is missing its API key"** — `GEMINI_API_KEY` wasn't saved,
  or was saved as plain text instead of a secret (shouldn't matter
  functionally, but re-add as a secret to be safe).
- **"Too many requests"** — the free Gemini tier has a per-minute cap; it
  resets within a minute, so just try again shortly.
- **Nothing happens / network error** — double check the Worker URL was
  copied in full, including `https://`.

## Updating the Worker later

Nothing to do — since the Worker is connected to GitHub, any update to
`worker.js` in this repo redeploys it automatically within a minute or so.
Your secrets from step 3 stay as they were.
