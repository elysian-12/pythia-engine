# Reliable hourly snapshot refresh — free setup

GitHub Actions' native cron is lossy. In our deployed repo it skipped
every hourly trigger for 90+ minutes despite the schedule being valid.
This doc gives you a 100% free, ~99.9% reliable alternative using
[cron-job.org](https://cron-job.org).

## How it works

```
cron-job.org          Vercel route                     GitHub
───────────  ──POST→  /api/cron/refresh   ──POST→     /repos/.../dispatches
(hourly)              (auth check + relay)             (fires the workflow)
                                                            │
                                                            ▼
                                                       refresh-snapshot.yml
                                                       runs the backtest
                                                       commits the snapshot
                                                       Vercel auto-redeploys
```

cron-job.org fires every hour → hits our Vercel API route at
`/api/cron/refresh` → that route uses a stored GitHub PAT to call
`repository_dispatch` → GitHub fires the workflow → fresh snapshot
ships to production. All four legs are free.

## One-time setup (≈ 5 min)

### 1. Generate a GitHub fine-grained PAT

1. Go to https://github.com/settings/tokens?type=beta
2. **Generate new token** (fine-grained)
3. **Token name:** `pythia-snapshot-cron`
4. **Expiration:** 1 year
5. **Repository access:** Only select repositories → `elysian-12/pythia-engine`
6. **Repository permissions:** scroll to **Actions** → **Read and write**
7. Click **Generate token**, **copy** the value (starts with `github_pat_`)

This PAT can ONLY trigger workflows on this one repo. If it leaks, the
worst an attacker can do is fire your refresh workflow more often.
Revoke + regenerate any time.

### 2. Add two env vars to Vercel

1. Go to your Vercel project → Settings → Environment Variables
2. Add `GITHUB_DISPATCH_PAT` = (the PAT from step 1)
3. Add `CRON_SECRET` = (any random string, e.g. `openssl rand -hex 32`)
4. Apply to **Production**
5. Redeploy (the env vars only apply to new deploys)

### 3. Set up cron-job.org

1. Sign up at https://cron-job.org (free, no credit card)
2. **Create cronjob**:
   - **Title:** `Pythia hourly refresh`
   - **URL:** `https://pythia-engine.vercel.app/api/cron/refresh`
   - **Schedule:** Every hour at minute 5 (`5 * * * *`) — minute 5 to dodge
     the `0 * * * *` cron storm
   - **Request method:** `GET`
   - **Advanced → HTTP request headers**:
     - Add header: name `Authorization`, value `Bearer YOUR_CRON_SECRET`
       (use the same string you set in Vercel env)
3. **Test run**: click **Test run** in cron-job.org. Should return
   `{"ok": true, "dispatched": "refresh-snapshot", ...}` from your
   Vercel function.
4. **Save & enable**.

That's it. Your Actions tab will start showing a `repository_dispatch`-
triggered run every hour from now on. The Vercel route logs every
invocation with status, so you can see in Vercel's logs whether
cron-job.org is hitting it on schedule.

## Verifying it works

Three places to check:

1. **cron-job.org dashboard** — shows last-fired time + HTTP status
2. **Vercel → your project → Logs** — filter for `/api/cron/refresh`
   and look for `200 OK` responses
3. **GitHub Actions tab** — new runs with `event=repository_dispatch`
   appear hourly:
   ```
   curl -s "https://api.github.com/repos/elysian-12/pythia-engine/actions/runs?event=repository_dispatch&per_page=5"
   ```

## If you don't want cron-job.org

The Vercel route at `/api/cron/refresh` accepts any GET with the right
`Authorization: Bearer $CRON_SECRET` header. You can call it from
anything: a laptop crontab, GitHub Actions in another repo, Cloudflare
Workers cron, your phone via Shortcuts, etc.

```sh
# laptop crontab line — hourly at minute 5
5 * * * * curl -s -H "Authorization: Bearer $CRON_SECRET" https://pythia-engine.vercel.app/api/cron/refresh
```

## When the cron isn't actually needed

The workflow also fires automatically on:
- **`push`** to the swarm/ingest crates or the bundler script
- **`workflow_dispatch`** — manual button on the Actions tab
- **`schedule: 0 * * * *`** — GitHub Actions native cron (lossy fallback)

So even with no external scheduler, you'll get a fresh snapshot every
time you push code that changes the model, plus whenever you hit
**Run workflow** before a demo. cron-job.org just makes the *background*
hourly refresh actually reliable.
