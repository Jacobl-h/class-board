# Runbook: deploying class-board

This is the owner's step-by-step guide. Everything here is free: a Cloudflare account on the
free plan (no card), and a public GitHub repository with GitHub Pages. Plan on about 30
minutes, plus a wait while the first screenshot renders.

You need: Node 24 and npm 11 installed, and this repository on your computer with
dependencies installed (`npm install` in the repo root).

## 1. Create a Cloudflare account

Go to https://dash.cloudflare.com/sign-up and sign up with your email. You don't need to add a
card or a domain. Verify your email address.

## 2. Log in with wrangler

```bash
cd worker
npx wrangler login
```

A browser tab opens. Click **Allow**. The terminal prints "Successfully logged in".

## 3. Set the teacher passcode

```bash
npx wrangler secret put TEACHER_CODE
```

Type a passcode only you know when prompted (nothing is shown as you type). If asked to create
a new Worker for the secret, answer yes. Students never see this value. Pick something you can
type quickly in front of a class.

## 4. Deploy the Worker

```bash
cd ..                        # back to the repo root
npm run deploy -w worker
```

The last lines print your Worker's address, like
`https://class-board.<your-subdomain>.workers.dev`. Copy it.

## 5. Tell the Worker its own address

Open `worker/wrangler.jsonc`, find the variable `PUBLIC_URL` under `vars`, and set it to the
address you just copied (no trailing slash):

```jsonc
"PUBLIC_URL": "https://class-board.<your-subdomain>.workers.dev"
```

Deploy again:

```bash
npm run deploy -w worker
```

The Worker uses `PUBLIC_URL` to take screenshots of uploaded HTML files, so screenshots of
uploads won't work until this is set.

## 6. Spike 2 check: screenshots from the Durable Object

This is the one thing the tests can't prove, because it needs your Cloudflare account. Browser
Rendering is called from inside the board's Durable Object, and Cloudflare doesn't document
that for the free plan.

1. Open the deployed board. Until step 9 the site isn't on GitHub Pages yet, so run it locally
   against the deployed Worker: in `web/`, start it with
   `VITE_SERVER_URL=https://class-board.<your-subdomain>.workers.dev npm run dev` (from the repo
   root: `VITE_SERVER_URL=... npm run dev -w web`), and open http://localhost:5173/?board=spike.
   The deployed Worker allows the origin `http://localhost:5173`, because that's in `ALLOWED_ORIGINS`.
2. Click an empty tile and upload any small `.html` file (or paste `<title>Spike</title><h1>Hello</h1>`).
3. Wait about a minute. The tile's card should get a screenshot image, and the History
   dialog should show a thumbnail.

To watch what happens on the server, run `cd worker && npx wrangler tail` in a second
terminal while you upload.

**If a screenshot appears:** Spike 2 passes. Nothing to change.

**If no screenshot appears within a few minutes** and `wrangler tail` shows an error from the
browser call (for example that the binding isn't available, or an authorization or
"not supported" error), switch to Browser Rendering's REST endpoint, which is called from the Worker
with an API token:

1. Create the token: Cloudflare dashboard → My Profile → API Tokens → Create Token → Create
   Custom Token. Give it the permission **Account → Browser Rendering → Edit**, for your
   account. Copy the token. Also copy your **Account ID** (dashboard home, right side).
2. Store them:

   ```bash
   cd worker
   npx wrangler secret put CF_API_TOKEN     # paste the token
   ```

   In `worker/wrangler.jsonc`, add `"CF_ACCOUNT_ID": "<your account id>"` under `vars`.
3. In `worker/src/env.ts`, add two optional fields to `Env`:

   ```ts
   CF_ACCOUNT_ID?: string;
   CF_API_TOKEN?: string;
   ```
4. In `worker/src/shots.ts`, add this next to `createBrowserShooter` (it uses the file's
   existing `Shooter` and `DailyLimitError`):

   ```ts
   /** Screenshots through Browser Rendering's REST endpoint instead of the Durable Object binding. */
   export function createRestShooter(accountId: string, token: string, fetchImpl: typeof fetch = fetch): Shooter {
     let lastAt = 0;
     return {
       async shoot(url: string): Promise<ArrayBuffer> {
         // The free plan allows about one REST request every 10 seconds.
         const wait = lastAt + 10_000 - Date.now();
         if (wait > 0) await new Promise((r) => setTimeout(r, wait));
         lastAt = Date.now();
         const res = await fetchImpl(
           `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/screenshot`,
           {
             method: 'POST',
             headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
             body: JSON.stringify({
               url,
               viewport: { width: 1280, height: 800 },
               screenshotOptions: { type: 'jpeg', quality: 70 },
               gotoOptions: { waitUntil: 'networkidle2', timeout: 15000 },
             }),
           },
         );
         if (res.status === 429) throw new DailyLimitError('Browser Rendering daily limit reached');
         if (!res.ok) throw new Error(`Screenshot request failed: HTTP ${res.status}`);
         return res.arrayBuffer();
       },
       async close() {},
     };
   }
   ```

   Cloudflare has been renaming these docs from "Browser Rendering" to "Browser Run". If the
   request returns 404, use the URL shown on
   https://developers.cloudflare.com/browser-rendering/rest-api/screenshot-endpoint/ instead
   (the path segment `browser-run` may read `browser-rendering`).
5. Find where the Durable Object builds its shooter with
   `grep -rn createBrowserShooter worker/src`. Replace the call so it uses the REST shooter when the
   token is present:

   ```ts
   this.env.CF_API_TOKEN && this.env.CF_ACCOUNT_ID
     ? createRestShooter(this.env.CF_ACCOUNT_ID, this.env.CF_API_TOKEN)
     : createBrowserShooter(this.env.BROWSER!)
   ```
6. Deploy again (`npm run deploy -w worker`) and repeat the check.

A screenshot that never appears never breaks the board. The tile keeps working, and its card
shows the title, icon and domain instead.

## 7. Create the GitHub repository and push

Create a **public** repository named `class-board` under the account `Jacobl-h`
(https://github.com/new). Don't add a README or license; the repository already has them. Then,
from the repo root:

```bash
git remote add origin https://github.com/Jacobl-h/class-board.git
git push -u origin main
```

(The build branch is `build/v1`. Merge it into `main` first, or push it and open a pull
request. The Pages workflow runs on pushes to `main`.)

## 8. Turn on GitHub Pages

In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## 9. Point the site at your Worker

In the repository: **Settings → Secrets and variables → Actions → Variables → New repository
variable**. Name: `SERVER_URL`. Value: your Worker address from step 4 (for example
`https://class-board.<your-subdomain>.workers.dev`).

Then run the workflow again: **Actions → Deploy site to GitHub Pages → Run workflow**. When it
finishes (a minute or two), the board is at https://jacobl-h.github.io/class-board/.

If the workflow fails at "Check the server URL is set", the variable is missing or empty.

## 10. Custom domain (only if you use one)

The Worker only accepts connections and uploads from the origins in `ALLOWED_ORIGINS`, and it
decides whether a site allows framing by comparing with `BOARD_ORIGIN`. If the board's page is
served from a different address than `https://jacobl-h.github.io`, edit both in
`worker/wrangler.jsonc`:

```jsonc
"ALLOWED_ORIGINS": "https://board.example.com,http://localhost:5173",
"BOARD_ORIGIN": "https://board.example.com"
```

and deploy again. Students would then add that host, not `jacobl-h.github.io`, to their
Claude artifact's Allowed domains, and the help dialog shows the host the page is served from.

## Pre-class checklist

Do this the day before, from the classroom if you can:

- [ ] Open the board on the school network, on a student-type laptop, and confirm it connects
  (the top bar shows people, and there's no "Can't reach the board server" banner).
- [ ] Check that `*.workers.dev` is reachable from that network. Some school filters block it. Open
  `https://class-board.<your-subdomain>.workers.dev/boards/main/files/00000000000000000000000000000000`
  in a browser: a plain "not found" page means the network reaches the Worker; a filter or
  block page means it doesn't.
- [ ] **If `*.workers.dev` is blocked:** move `jacoblehrer.com`'s DNS from GoDaddy to
  Cloudflare, carrying the GitHub Pages records over unchanged, and give the Worker a custom
  domain such as `board-api.jacoblehrer.com`. Concretely:
  1. In Cloudflare, add the site `jacoblehrer.com` (free plan). It imports the existing records;
     compare them against GoDaddy's list and make sure the GitHub Pages records (the four `A`
     records for `@`, and the `CNAME` for `www`) are all there.
  2. At GoDaddy, change the domain's nameservers to the two Cloudflare gives you. Wait until
     Cloudflare says the site is active. The portfolio keeps working during this.
  3. In `worker/wrangler.jsonc`, add `"routes": [{ "pattern": "board-api.jacoblehrer.com", "custom_domain": true }]`,
     set `PUBLIC_URL` to `https://board-api.jacoblehrer.com`, and deploy.
  4. Change the repository variable `SERVER_URL` to `https://board-api.jacoblehrer.com` and re-run
     the Pages workflow.
- [ ] Run the load test against the deployed Worker, on its own board, so it doesn't touch the
  class's board:
  `node scripts/loadtest.mjs https://class-board.<your-subdomain>.workers.dev loadtest 75 60 5`.
  It prints how much of the day's 2,000,000-message budget a 75-minute class would use. Expect
  about a third of it with real students, and more with this test, because it moves every
  cursor nonstop.
- [ ] Open the board yourself, log in as teacher, and test Lock and Unlock once.
- [ ] Try one Claude artifact both ways: uploading its HTML file, and posting its published link
  after adding the board's host to Allowed domains.

## Student instructions

Put this on the whiteboard or in the class chat:

1. Open https://jacobl-h.github.io/class-board/ and type your name in the "Your cursor" panel.
2. Click an empty tile to add something.
3. **Easiest for a Claude artifact:** in Claude, download or copy the artifact's HTML, then choose
   **HTML** in the dialog and upload the file (or paste the HTML). Nothing else to set up.
4. **To post its link instead:** in Claude, **Publish → Get embed code → Allowed domains**, add
   `jacobl-h.github.io`, then paste the published link (the one that looks like
   `claude.ai/public/artifacts/…`). Newer artifacts made with the Share button can't be shown;
   upload their HTML file instead.

## Daily limits

The board runs entirely on Cloudflare's free plan. Going over a limit never costs money: the
feature just stops working until the limits reset at **00:00 UTC** (in the evening in the US:
8 pm Eastern in summer, 7 pm in winter). What students see:

| Limit (free plan) | What students see when it's reached |
|---|---|
| About 2,000,000 incoming realtime messages a day (cursor movement is nearly all of it). At 80%, cursors slow to 2 updates a second; at 90% they pause. | A notice: "Cursors are paused until midnight UTC to stay within the free limit." Posting, replacing and restoring keep working. |
| 100,000 Durable Object requests a day (20 incoming messages count as 1) and 100,000 Worker requests a day | Connections are refused. The page says: "The board has hit today's free limit. It'll be back at midnight UTC." |
| Browser Rendering: 10 minutes of browser time a day | New tiles get a card with the title, icon and domain instead of a screenshot. Queued screenshots are retried after 00:05 UTC. YouTube links use YouTube's own thumbnail and cost nothing. |
| Durable Object storage writes (100,000 rows a day) | Posts and edits fail with an error in the dialog. A normal class uses a tiny fraction. |

A normal 75-minute class uses about a third of the message budget. If cursors pause partway
through a class, cursors return at midnight UTC. Opening a second board doesn't help, because the
budget is per Worker, not per board. To reduce the load, ask students to keep their mouse still
when they aren't using the board.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "Can't reach the board server" | The Worker address is wrong or blocked. Check the `SERVER_URL` variable and the pre-class network check. |
| Page loads, nothing connects, the Worker log says origin | The page's address isn't in `ALLOWED_ORIGINS`. See step 10. |
| Teacher login says the code is wrong | Re-run `npx wrangler secret put TEACHER_CODE` in `worker/`, then deploy. Five wrong tries lock the login for 10 minutes. |
| A live tile is blank | The site allows framing but shows nothing for embedded visitors. Use the tile's "Open in new tab" button. |
| No screenshots | See step 6 (Spike 2) and run `npx wrangler tail` in `worker/` while a tile is posted. |
