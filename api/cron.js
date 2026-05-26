// BioHarmonize Agent 3: Auto-Publisher (self-contained Vercel function)
// Cron runs daily at 16:00 UTC (9am PT during PDT, 8am PT during PST).
// Based on day-of-week, publishes approved content from Dropbox /BioHarmonize/03_Published/
// to: Shopify (Thu), Reddit + Klaviyo (Fri), X thread (Sat).
// Successfully published files are moved to /BioHarmonize/04_Done/.
//
// Env vars (required for Dropbox + the channels you want active):
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
//   SHOPIFY_STORE_DOMAIN (e.g. "bioharmonize.myshopify.com"), SHOPIFY_ADMIN_TOKEN, SHOPIFY_BLOG_HANDLE (default "field-notes")
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD, REDDIT_SUBREDDIT (default "bioharmonize")
//   KLAVIYO_API_KEY, KLAVIYO_LIST_ID, KLAVIYO_FROM_EMAIL (default "hello@bioharmonize.co"), KLAVIYO_FROM_NAME (default "BioHarmonize")
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET (OAuth 1.0a)
// Optional:
//   CRON_SECRET (if set, requires Bearer header)
//   FORCE_DAY (override day-of-week for testing, e.g. "thursday")
//   DRY_RUN (if "1", logs what would be published but doesn't actually publish or move files)

import crypto from "crypto";

// ============================================================================
// CONFIG
// ============================================================================

const PUBLISHED_FOLDER = "/BioHarmonize/03_Published";
const DONE_FOLDER = "/BioHarmonize/04_Done";
const STATUS_FOLDER = "/BioHarmonize/_status";

// Schedule mapping (Pacific day -> channels). Cron runs at 16:00 UTC = 9am PDT / 8am PST.
const SCHEDULE = {
  thursday: ["shopify"],
  friday: ["reddit", "klaviyo"],
  saturday: ["x"],
};

// ============================================================================
// UTILITIES
// ============================================================================

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var missing`);
  return v;
}

function has(name) {
  return Boolean(process.env[name]);
}

function getDayName() {
  if (process.env.FORCE_DAY) return process.env.FORCE_DAY.toLowerCase();
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return days[new Date().getUTCDay()];
}

function slugFromCanonicalName(name) {
  // bedroom-audit.md -> bedroom-audit
  return name.replace(/\.md$/i, "");
}

// Minimal markdown to HTML converter for Shopify blog body.
// Handles headings, bold, italic, links, lists, paragraphs, hr.
function markdownToHtml(md) {
  let html = md;
  // Code blocks (not expected in our content, but safe)
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${escapeHtml(code)}</code></pre>`);
  // Headings (process longer first)
  html = html.replace(/^###### (.*)$/gm, "<h6>$1</h6>");
  html = html.replace(/^##### (.*)$/gm, "<h5>$1</h5>");
  html = html.replace(/^#### (.*)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  // Horizontal rule
  html = html.replace(/^---$/gm, "<hr/>");
  // Bold then italic (order matters for ** and *)
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+?)\*/g, "$1<em>$2</em>");
  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Paragraph splitting: split on blank lines, wrap non-block lines in <p>
  const blocks = html.split(/\n\n+/);
  const wrapped = blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";
    // Already a block element?
    if (/^<(h\d|hr|pre|ul|ol|li|blockquote|p|div)\b/i.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, "<br/>")}</p>`;
  });
  return wrapped.filter(Boolean).join("\n\n");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Parse Klaviyo derivative format:
// SUBJECT: ...
// PREVIEW: ...
// ---
// body...
function parseKlaviyo(content) {
  const subjectMatch = content.match(/^SUBJECT:\s*(.+)$/m);
  const previewMatch = content.match(/^PREVIEW:\s*(.+)$/m);
  const bodyMatch = content.split(/^---$/m).slice(1).join("---").trim();
  return {
    subject: subjectMatch ? subjectMatch[1].trim() : "BioHarmonize update",
    preview: previewMatch ? previewMatch[1].trim() : "",
    body: bodyMatch,
  };
}

// Parse Reddit derivative: first line is title, rest is body
function parseReddit(content) {
  const lines = content.split("\n");
  let titleIdx = 0;
  while (titleIdx < lines.length && !lines[titleIdx].trim()) titleIdx++;
  const title = (lines[titleIdx] || "").trim();
  const body = lines.slice(titleIdx + 1).join("\n").trim();
  return { title, body };
}

// Parse X thread: posts separated by ---POST--- delimiter
function parseXThread(content) {
  return content
    .split(/^---POST---\s*$/m)
    .map((p) => p.trim())
    .filter(Boolean);
}

// ============================================================================
// DROPBOX CLIENT (refresh token flow)
// ============================================================================

let cachedAccessToken = null;
let cachedExpiresAt = 0;

async function getDropboxAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiresAt - 60_000) return cachedAccessToken;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: need("DROPBOX_REFRESH_TOKEN"),
  });
  const auth = Buffer.from(`${need("DROPBOX_APP_KEY")}:${need("DROPBOX_APP_SECRET")}`).toString("base64");
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Dropbox token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedExpiresAt = Date.now() + (data.expires_in || 14400) * 1000;
  return cachedAccessToken;
}

async function dropboxAuth() {
  return { Authorization: `Bearer ${await getDropboxAccessToken()}` };
}

async function listFolder(path) {
  const res = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: { ...(await dropboxAuth()), "Content-Type": "application/json" },
    body: JSON.stringify({ path, recursive: false, limit: 200 }),
  });
  if (!res.ok) throw new Error(`Dropbox listFolder failed: ${res.status} ${await res.text()}`);
  return (await res.json()).entries || [];
}

async function downloadFile(path) {
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { ...(await dropboxAuth()), "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!res.ok) throw new Error(`Dropbox downloadFile failed: ${res.status} ${await res.text()}`);
  return await res.text();
}

async function ensureFolder(path) {
  // Attempts to create folder. Ignores "already exists" errors.
  const res = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
    method: "POST",
    headers: { ...(await dropboxAuth()), "Content-Type": "application/json" },
    body: JSON.stringify({ path, autorename: false }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (!/path\/conflict\/folder/.test(txt)) {
      console.warn(`ensureFolder ${path} non-fatal:`, txt.slice(0, 200));
    }
  }
}

async function uploadJsonFile(path, obj) {
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      ...(await dropboxAuth()),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path, mode: "overwrite", autorename: false, mute: true, strict_conflict: false,
      }),
    },
    body: JSON.stringify(obj, null, 2),
  });
  if (!res.ok) console.warn(`uploadJsonFile ${path}:`, (await res.text()).slice(0, 200));
}

async function writeStatus(payload) {
  try {
    await ensureFolder(STATUS_FOLDER);
    await uploadJsonFile(`${STATUS_FOLDER}/agent_3_last_run.json`, {
      agent: "agent_3_publisher",
      ...payload,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("writeStatus failed:", err.message);
  }
}

async function moveFile(fromPath, toPath) {
  const res = await fetch("https://api.dropboxapi.com/2/files/move_v2", {
    method: "POST",
    headers: { ...(await dropboxAuth()), "Content-Type": "application/json" },
    body: JSON.stringify({
      from_path: fromPath,
      to_path: toPath,
      allow_shared_folder: false,
      autorename: true,
      allow_ownership_transfer: false,
    }),
  });
  if (!res.ok) throw new Error(`Dropbox moveFile failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ============================================================================
// SHOPIFY PUBLISHER (Admin GraphQL API)
// ============================================================================

async function publishToShopify({ slug, content }) {
  if (!has("SHOPIFY_STORE_DOMAIN") || !has("SHOPIFY_ADMIN_TOKEN")) {
    return { skipped: true, reason: "SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN not set" };
  }
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const blogHandle = process.env.SHOPIFY_BLOG_HANDLE || "field-notes";

  // Extract title from first H1 line of markdown
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : slug.replace(/-/g, " ");
  const bodyHtml = markdownToHtml(content);

  // Find blog ID by handle
  const blogsQuery = `query { blogs(first: 50) { nodes { id handle title } } }`;
  const blogsRes = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: blogsQuery }),
  });
  if (!blogsRes.ok) {
    throw new Error(`Shopify blogs query failed: ${blogsRes.status} ${await blogsRes.text()}`);
  }
  const blogsData = await blogsRes.json();
  const blogs = blogsData?.data?.blogs?.nodes || [];
  const blog = blogs.find((b) => b.handle === blogHandle);
  if (!blog) {
    return { skipped: true, reason: `Shopify blog with handle "${blogHandle}" not found. Found: ${blogs.map((b) => b.handle).join(", ")}` };
  }

  // Create article. Author is required by ArticleCreateInput.
  const authorName = process.env.SHOPIFY_AUTHOR_NAME || "BioHarmonize";
  const publicDomain = process.env.SHOPIFY_PUBLIC_DOMAIN || "bioharmonize.co";
  const mutation = `
    mutation articleCreate($article: ArticleCreateInput!) {
      articleCreate(article: $article) {
        article { id title handle }
        userErrors { field message code }
      }
    }`;
  const variables = {
    article: {
      blogId: blog.id,
      title,
      handle: slug,
      body: bodyHtml,
      isPublished: true,
      publishDate: new Date().toISOString(),
      author: { name: authorName },
    },
  };
  const createRes = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation, variables }),
  });
  if (!createRes.ok) {
    throw new Error(`Shopify articleCreate HTTP failed: ${createRes.status} ${await createRes.text()}`);
  }
  const createData = await createRes.json();
  // Top-level GraphQL errors (schema/validation) come back outside of userErrors
  if (Array.isArray(createData?.errors) && createData.errors.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(createData.errors)}`);
  }
  const errs = createData?.data?.articleCreate?.userErrors || [];
  if (errs.length) {
    throw new Error(`Shopify userErrors: ${JSON.stringify(errs)}`);
  }
  const article = createData?.data?.articleCreate?.article;
  if (!article?.id) {
    throw new Error(`Shopify articleCreate returned no article: ${JSON.stringify(createData)}`);
  }
  return {
    success: true,
    platform: "shopify",
    articleId: article.id,
    url: `https://${publicDomain}/blogs/${blogHandle}/${slug}`,
  };
}

// ============================================================================
// REDDIT PUBLISHER (OAuth password grant + submit)
// ============================================================================

async function getRedditToken() {
  const auth = Buffer.from(`${need("REDDIT_CLIENT_ID")}:${need("REDDIT_CLIENT_SECRET")}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username: need("REDDIT_USERNAME"),
    password: need("REDDIT_PASSWORD"),
  });
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "bioharmonize-agent3/1.0",
    },
    body,
  });
  if (!res.ok) throw new Error(`Reddit token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`Reddit no token in response: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function publishToReddit({ slug, content }) {
  if (!has("REDDIT_CLIENT_ID") || !has("REDDIT_CLIENT_SECRET") || !has("REDDIT_USERNAME") || !has("REDDIT_PASSWORD")) {
    return { skipped: true, reason: "Reddit credentials not fully set (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD all required)" };
  }
  const sr = process.env.REDDIT_SUBREDDIT || "bioharmonize";
  const { title, body } = parseReddit(content);
  if (!title) throw new Error("Reddit post missing title (first line)");

  const token = await getRedditToken();
  const body_ = new URLSearchParams({
    sr,
    title,
    kind: "self",
    text: body,
    api_type: "json",
  });
  const res = await fetch("https://oauth.reddit.com/api/submit", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "bioharmonize-agent3/1.0",
    },
    body: body_,
  });
  if (!res.ok) throw new Error(`Reddit submit failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const errs = data?.json?.errors || [];
  if (errs.length) throw new Error(`Reddit submit errors: ${JSON.stringify(errs)}`);
  const url = data?.json?.data?.url;
  return { success: true, platform: "reddit", url, subreddit: sr };
}

// ============================================================================
// KLAVIYO PUBLISHER (creates a draft campaign; user sends manually)
// ============================================================================

async function publishToKlaviyo({ slug, content }) {
  if (!has("KLAVIYO_API_KEY") || !has("KLAVIYO_LIST_ID")) {
    return { skipped: true, reason: "Klaviyo credentials not set (KLAVIYO_API_KEY + KLAVIYO_LIST_ID required)" };
  }
  const apiKey = process.env.KLAVIYO_API_KEY;
  const listId = process.env.KLAVIYO_LIST_ID;
  const fromEmail = process.env.KLAVIYO_FROM_EMAIL || "hello@bioharmonize.co";
  const fromName = process.env.KLAVIYO_FROM_NAME || "BioHarmonize";

  const { subject, preview, body } = parseKlaviyo(content);
  // Convert markdown body to HTML for email
  const bodyHtml = markdownToHtml(body);
  const fullHtml = `<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #222; line-height: 1.6;">${bodyHtml}</body></html>`;

  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    "Content-Type": "application/vnd.api+json",
    accept: "application/vnd.api+json",
    revision: "2024-10-15",
  };

  // 1. Create campaign with message + send strategy
  const campaignBody = {
    data: {
      type: "campaign",
      attributes: {
        name: `${slug} - Auto draft ${new Date().toISOString().slice(0, 10)}`,
        audiences: {
          included: [listId],
        },
        send_strategy: {
          method: "static",
          options_static: {
            datetime: new Date(Date.now() + 24 * 3600_000).toISOString(),
            is_local: false,
          },
        },
        "campaign-messages": {
          data: [
            {
              type: "campaign-message",
              attributes: {
                label: "Main",
                channel: "email",
                content: {
                  subject,
                  preview_text: preview,
                  from_email: fromEmail,
                  from_label: fromName,
                  reply_to_email: fromEmail,
                },
              },
            },
          ],
        },
      },
    },
  };
  const createRes = await fetch("https://a.klaviyo.com/api/campaigns/", {
    method: "POST",
    headers,
    body: JSON.stringify(campaignBody),
  });
  if (!createRes.ok) throw new Error(`Klaviyo campaign create failed: ${createRes.status} ${await createRes.text()}`);
  const created = await createRes.json();
  const campaignId = created?.data?.id;
  if (!campaignId) throw new Error(`Klaviyo no campaign id: ${JSON.stringify(created)}`);

  // 2. Find the campaign message ID
  const msgsRes = await fetch(`https://a.klaviyo.com/api/campaigns/${campaignId}/campaign-messages/`, {
    headers,
  });
  if (!msgsRes.ok) throw new Error(`Klaviyo campaign-messages get failed: ${msgsRes.status} ${await msgsRes.text()}`);
  const msgsData = await msgsRes.json();
  const messageId = msgsData?.data?.[0]?.id;
  if (!messageId) throw new Error(`Klaviyo no message id: ${JSON.stringify(msgsData)}`);

  // 3. Create a template with our HTML
  const templateBody = {
    data: {
      type: "template",
      attributes: {
        name: `${slug} - email template`,
        editor_type: "CODE",
        html: fullHtml,
      },
    },
  };
  const tplRes = await fetch("https://a.klaviyo.com/api/templates/", {
    method: "POST",
    headers,
    body: JSON.stringify(templateBody),
  });
  if (!tplRes.ok) throw new Error(`Klaviyo template create failed: ${tplRes.status} ${await tplRes.text()}`);
  const tplData = await tplRes.json();
  const templateId = tplData?.data?.id;
  if (!templateId) throw new Error(`Klaviyo no template id: ${JSON.stringify(tplData)}`);

  // 4. Assign template to campaign message
  const assignBody = {
    data: {
      type: "campaign-message",
      id: messageId,
      relationships: { template: { data: { type: "template", id: templateId } } },
    },
  };
  const assignRes = await fetch("https://a.klaviyo.com/api/campaign-message-assign-template/", {
    method: "POST",
    headers,
    body: JSON.stringify(assignBody),
  });
  if (!assignRes.ok) throw new Error(`Klaviyo assign template failed: ${assignRes.status} ${await assignRes.text()}`);

  return {
    success: true,
    platform: "klaviyo",
    campaignId,
    reviewUrl: `https://www.klaviyo.com/campaign/${campaignId}/edit`,
    note: "Campaign created as draft. Review and send manually in Klaviyo dashboard.",
  };
}

// ============================================================================
// X (TWITTER) PUBLISHER (OAuth 1.0a, posts thread directly via X API v2)
// ============================================================================

function pctEncode(s) {
  // RFC 3986 percent encoding (encodeURIComponent + escape !, *, ', (, ))
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildOAuthAuthHeader({ method, url, oauthParams, consumerSecret, tokenSecret, bodyParams = {} }) {
  // Combine OAuth params + body params for signature base string
  const allParams = { ...oauthParams, ...bodyParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys.map((k) => `${pctEncode(k)}=${pctEncode(allParams[k])}`).join("&");
  const baseString = [method.toUpperCase(), pctEncode(url), pctEncode(paramString)].join("&");
  const signingKey = `${pctEncode(consumerSecret)}&${pctEncode(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  const headerParams = { ...oauthParams, oauth_signature: signature };
  const headerValue = "OAuth " + Object.keys(headerParams).sort().map((k) =>
    `${pctEncode(k)}="${pctEncode(headerParams[k])}"`
  ).join(", ");
  return headerValue;
}

async function postOneTweet({ text, replyToId, creds }) {
  const url = "https://api.x.com/2/tweets";
  const oauthParams = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  // For JSON-body requests to X v2, body params are NOT included in OAuth signature
  // (only query string params would be). So we pass empty bodyParams.
  const authHeader = buildOAuthAuthHeader({
    method: "POST",
    url,
    oauthParams,
    consumerSecret: creds.consumerSecret,
    tokenSecret: creds.tokenSecret,
    bodyParams: {},
  });
  const body = replyToId
    ? { text, reply: { in_reply_to_tweet_id: replyToId } }
    : { text };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`X API ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const id = data?.data?.id;
  if (!id) throw new Error(`X returned no tweet id: ${JSON.stringify(data).slice(0, 300)}`);
  return id;
}

async function publishToX({ slug, content }) {
  if (!has("X_API_KEY") || !has("X_API_SECRET") || !has("X_ACCESS_TOKEN") || !has("X_ACCESS_TOKEN_SECRET")) {
    return { skipped: true, reason: "X credentials not fully set (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET all required)" };
  }
  const posts = parseXThread(content);
  if (posts.length === 0) throw new Error("X thread has no posts after parsing");

  const creds = {
    consumerKey: process.env.X_API_KEY,
    consumerSecret: process.env.X_API_SECRET,
    token: process.env.X_ACCESS_TOKEN,
    tokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
  };

  const tweetIds = [];
  let previousId = null;
  for (const text of posts) {
    const id = await postOneTweet({ text, replyToId: previousId, creds });
    tweetIds.push(id);
    previousId = id;
  }

  // Get username for URL construction (default to BioHarmonize, could derive from access token)
  const username = "BioHarmonize";
  return {
    success: true,
    platform: "x",
    threadLength: tweetIds.length,
    firstTweetUrl: `https://x.com/${username}/status/${tweetIds[0]}`,
    tweetIds,
  };
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

// Returns the file path to use for each channel given the list of files in /03_Published/.
// Channel -> filename suffix mapping.
function findFileForChannel(channel, entries) {
  const suffixMap = {
    shopify: null, // canonical (no _suffix)
    reddit: "_reddit",
    klaviyo: "_klaviyo",
    x: "_x",
  };
  const suffix = suffixMap[channel];
  for (const e of entries) {
    if (e[".tag"] !== "file" || !e.name.toLowerCase().endsWith(".md")) continue;
    const base = e.name.replace(/\.md$/i, "");
    if (suffix === null) {
      // Canonical: no _reddit, _klaviyo, _x suffix
      if (!/_reddit$|_klaviyo$|_x$/.test(base)) return e;
    } else if (base.endsWith(suffix)) {
      return e;
    }
  }
  return null;
}

const PUBLISHERS = {
  shopify: publishToShopify,
  reddit: publishToReddit,
  klaviyo: publishToKlaviyo,
  x: publishToX,
};

async function runForChannel(channel, entries, dryRun) {
  const file = findFileForChannel(channel, entries);
  if (!file) return { channel, skipped: true, reason: "No matching file in /03_Published/" };

  const filePath = file.path_lower || file.path_display;
  const filename = file.name;
  const slug = slugFromCanonicalName(filename).replace(/_reddit$|_klaviyo$|_x$/, "");

  if (dryRun) {
    return { channel, dryRun: true, wouldPublish: filename, slug };
  }

  const content = await downloadFile(filePath);
  let result;
  try {
    result = await PUBLISHERS[channel]({ slug, content });
  } catch (err) {
    return { channel, file: filename, success: false, error: err.message };
  }

  if (result.skipped) return { channel, file: filename, ...result };

  // Move file to /04_Done/
  try {
    const newName = `${slug}_${channel}_${new Date().toISOString().slice(0, 10)}.md`;
    await moveFile(filePath, `${DONE_FOLDER}/${newName}`);
    result.moved = `${DONE_FOLDER}/${newName}`;
  } catch (err) {
    result.moveError = err.message;
  }

  return { channel, file: filename, ...result };
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const dryRun = process.env.DRY_RUN === "1" || req.query?.dry === "1";
  const day = req.query?.day || getDayName();
  const channelsForToday = req.query?.channel ? [req.query.channel] : SCHEDULE[day] || [];

  try {
    await ensureFolder(DONE_FOLDER);

    if (channelsForToday.length === 0) {
      const payload = {
        ok: true, day,
        message: `No channels scheduled for ${day}. Schedule: ${JSON.stringify(SCHEDULE)}`,
      };
      await writeStatus(payload);
      return res.status(200).json({ ...payload, timestamp: new Date().toISOString() });
    }

    const entries = await listFolder(PUBLISHED_FOLDER);
    const results = [];
    for (const channel of channelsForToday) {
      const r = await runForChannel(channel, entries, dryRun);
      results.push(r);
      console.log(`[${channel}]`, JSON.stringify(r));
    }

    const payload = {
      ok: true,
      day,
      dryRun,
      channels: channelsForToday,
      filesInPublished: entries.filter((e) => e[".tag"] === "file").map((e) => e.name),
      results,
    };
    await writeStatus(payload);
    return res.status(200).json({ ...payload, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("Agent 3 failed:", err);
    const payload = { ok: false, error: err.message, stack: err.stack };
    await writeStatus(payload).catch(() => {});
    return res.status(500).json({ ...payload, timestamp: new Date().toISOString() });
  }
}
