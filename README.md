# BioHarmonize Agent 3: Auto-Publisher

Vercel-hosted cron that watches Dropbox `/BioHarmonize/03_Published/` for approved canonical posts and derivatives, then publishes each to its target platform on the right day of the week. Successfully published files are moved to `/BioHarmonize/04_Done/`.

## Architecture

Single Vercel function (`api/cron.js`) runs daily at 16:00 UTC (9am PT during PDT, 8am PT during PST). On each run, it checks today's day of the week and processes the matching channels:

| Pacific day | Channels | Source file |
|---|---|---|
| Thursday | Shopify (canonical blog post) | `<slug>.md` (no suffix) |
| Friday | Reddit + Klaviyo | `<slug>_reddit.md`, `<slug>_klaviyo.md` |
| Saturday | Typefully (schedules X thread) | `<slug>_x.md` |

A file only publishes once: after success it's renamed and moved to `/04_Done/`. On other days nothing happens (the cron returns a no-op).

## Graceful skip behavior

Each platform publisher checks its required env vars. If anything is missing, the channel logs a `skipped: true` result and the cron keeps running for other channels. This means you can deploy with Dropbox creds alone and activate Shopify, Reddit, Klaviyo, Typefully one at a time as you gather credentials.

## Environment variables

### Required (Dropbox; reuse from Agent 2)
- `DROPBOX_APP_KEY` (e.g., `2eptg0ga0e1348d`)
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

### Required for Shopify channel
- `SHOPIFY_STORE_DOMAIN` — e.g., `bioharmonize.myshopify.com` (NOT bioharmonize.co)
- `SHOPIFY_ADMIN_TOKEN` — Admin API access token starting with `shpat_`
- `SHOPIFY_BLOG_HANDLE` — default `field-notes` (override if your blog handle differs)

### Required for Reddit channel
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `REDDIT_USERNAME`
- `REDDIT_PASSWORD`
- `REDDIT_SUBREDDIT` — default `bioharmonize`

### Required for Klaviyo channel
- `KLAVIYO_API_KEY` — Private API key starting with `pk_`
- `KLAVIYO_LIST_ID` — target list ID
- `KLAVIYO_FROM_EMAIL` — default `hello@bioharmonize.co`
- `KLAVIYO_FROM_NAME` — default `BioHarmonize`

### Required for Typefully channel
- `TYPEFULLY_API_KEY`

### Optional
- `CRON_SECRET` — if set, the endpoint requires `Authorization: Bearer <secret>`
- `FORCE_DAY` — override day-of-week (`thursday`, `friday`, `saturday`) for testing
- `DRY_RUN` — set to `1` to log what would publish without doing it

## Credential setup: step-by-step

### Shopify Admin API token (~5 min)

1. Go to your Shopify admin: `https://admin.shopify.com/store/<your-store>/settings/apps`
2. Click **Develop apps** > **Allow custom app development** if first time
3. Click **Create an app**, name it `BioHarmonize Agent 3`
4. Click **Configure Admin API scopes**, check at minimum:
   - `write_content` (create blog articles)
   - `read_content` (find your blog by handle)
5. Click **Save**
6. Click **Install app**
7. After install, you'll see the **Admin API access token** (starts with `shpat_`). Copy it
8. Your `SHOPIFY_STORE_DOMAIN` is your myshopify domain — check via Settings > Domains. Format: `<storename>.myshopify.com`

### Reddit OAuth app (~5 min)

1. Go to `https://www.reddit.com/prefs/apps`
2. Scroll down, click **are you a developer? create an app...**
3. Fill in:
   - Name: `BioHarmonize Agent 3`
   - Type: **script** (important — script type uses password grant)
   - Redirect URI: `http://localhost:8080` (required but unused for script apps)
4. Click **Create app**
5. The `REDDIT_CLIENT_ID` is the string under the app name (looks like `abc123XYZ`)
6. The `REDDIT_CLIENT_SECRET` is shown as `secret` in the app details
7. `REDDIT_USERNAME` and `REDDIT_PASSWORD` are your Reddit account credentials
8. For `REDDIT_SUBREDDIT`, this needs to be a subreddit where you can post (your own r/bioharmonize once it's created, or a relevant existing one)

**Important:** Reddit's script-type apps work for the account that created them only. If r/bioharmonize doesn't exist yet, create it first (`Create a Community` button on reddit.com).

### Klaviyo Private API Key (~3 min)

1. Sign in to Klaviyo: `https://www.klaviyo.com/`
2. Click your account icon (bottom left) > **Settings**
3. Go to **API Keys** > **Create Private API Key**
4. Name: `BioHarmonize Agent 3`
5. Scopes (full access not needed — minimum required):
   - `campaigns:write`
   - `campaigns:read`
   - `templates:write`
   - `templates:read`
   - `lists:read`
6. Click **Create**, copy the key (starts with `pk_`)

**List ID:**
1. In Klaviyo, go to **Lists & Segments**
2. Click into your target list (probably "Newsletter Subscribers" or similar)
3. The list ID is in the URL: `https://www.klaviyo.com/list/<LIST_ID>/...` — it's a 6-character alphanumeric

### Typefully API key (~5 min)

1. Sign up at `https://typefully.com/` (free tier works)
2. Connect your X/Twitter account when prompted
3. Go to Settings > Integrations > API
4. Generate an API key, copy it
5. Free tier limits apply (10 scheduled drafts per month last I checked). For our weekly volume this is plenty.

## Deploy to Vercel

Same flow as Agent 2:

1. Create new GitHub repo `bioharmonize-agent3` (can be public)
2. Upload these files (use folder drag for proper structure, or use the create-file UI for `api/cron.js`)
3. Go to `vercel.com/new`, import the repo
4. Add the env vars you have ready (Dropbox is minimum; others can be added later)
5. Click **Deploy**

The cron auto-registers. You can manually trigger from Vercel Project > Settings > Cron Jobs > Trigger Now.

## Test mode

To test without publishing (and without affecting any files):

```bash
curl "https://your-deployment.vercel.app/api/cron?dry=1"
```

To force a specific day:

```bash
curl "https://your-deployment.vercel.app/api/cron?day=thursday&dry=1"
```

To run a single channel:

```bash
curl "https://your-deployment.vercel.app/api/cron?channel=shopify&dry=1"
```

## Expected response

```json
{
  "ok": true,
  "day": "thursday",
  "channels": ["shopify"],
  "filesInPublished": ["bedroom-audit.md", "bedroom-audit_reddit.md"],
  "results": [
    {
      "channel": "shopify",
      "file": "bedroom-audit.md",
      "success": true,
      "articleId": "gid://shopify/Article/...",
      "url": "https://bioharmonize.co/blogs/field-notes/bedroom-audit",
      "moved": "/BioHarmonize/04_Done/bedroom-audit_shopify_2026-05-23.md"
    }
  ]
}
```

## Cost

- Vercel: $0 (Hobby tier, 1 cron/day allowed)
- API calls: free across all platforms at this volume
- Total: $0/month

## What's not in v1 (deliberately deferred)

- **Klaviyo auto-send.** The function creates the campaign as a draft and assigns the template. You manually click Send in the Klaviyo UI. This is intentional — emails go out to thousands of subscribers, sending on autopilot is risky for v1. Once you trust the output, you can add a `campaign-send-jobs` API call to send automatically.
- **Typefully auto-schedule.** Same reasoning — creates draft, you schedule manually for now. Easy to flip to auto-schedule via `schedule_date` parameter once trusted.
- **Reddit comments / cross-posting.** v1 just submits to one subreddit.
- **Retry on transient errors.** A single failed run logs the error and leaves the file in `/03_Published/` for the next day's run to retry.

## File structure

```
agent3-vercel/
├── api/
│   └── cron.js              # All logic in one file
├── package.json
├── vercel.json              # Cron at 16:00 UTC daily
├── README.md
└── .gitignore
```
