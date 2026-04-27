# Reliable hourly snapshot refresh

GitHub Actions' native `schedule:` cron is lossy under platform load —
in our deployed repo it skipped every hourly trigger for hours despite
the schedule being valid. Vercel's free Hobby tier only allows
**daily** cron, not hourly. This doc shows the working setup: a free
external scheduler hits GitHub's `repository_dispatch` endpoint
directly, which fires the workflow reliably regardless of platform
load.

## Architecture (verified working)

```
cron-job.org    POST    GitHub REST API                refresh-snapshot.yml
(hourly)    ────────▶   /repos/<owner>/<repo>/dispatches   ────────────▶
                        (auth: fine-grained PAT)         backtest → bundle → commit
                                                              │
                                                              ▼
                                                         Vercel auto-redeploys
                                                         from the new commit
```

All four legs are free (cron-job.org free tier · GitHub Actions free
tier · Vercel Hobby · GitHub repo storage).

## One-time setup (≈5 min)

### 1. Generate a fine-grained GitHub PAT

1. Open https://github.com/settings/tokens?type=beta → **Generate new token**
2. **Token name:** `pythia-snapshot-cron`
3. **Resource owner:** your account (`elysian-12`)
4. **Expiration:** 1 year (you'll see a renewal reminder ~7 days before)
5. **Repository access:** `Only select repositories` → check
   **`elysian-12/pythia-engine`**
6. **Repository permissions** — scroll down, find:
   - **`Contents`** → set to **`Read and write`** ⚠️ this is the
     critical one. The GitHub docs at the top of the dispatch
     endpoint say "must have admin access" but the actual
     fine-grained scope required is `Contents: Write`. The header
     `x-accepted-github-permissions: contents=write` on the
     response confirms it. Without this you get **`403 Forbidden`**.
   - **`Metadata`** → `Read-only` (auto-required by GitHub)
   - All others → `No access`
7. **Generate token**, **copy** the value immediately (`github_pat_…`)
   — you can't see it again after closing the page.

### 2. Set up cron-job.org

1. Sign up at https://cron-job.org (free, no credit card)
2. Click **Create cronjob** and fill the **Common** tab:
   - **Title:** `Pythia hourly refresh`
   - **URL:** `https://api.github.com/repos/elysian-12/pythia-engine/dispatches`
   - **Execution schedule:** select **`Every 1 hour`** (crontab `0 * * * *`)
3. Switch to the **Advanced** tab:
   - **Request method:** change `GET` → **`POST`** (this is critical;
     GitHub's dispatch endpoint rejects GET)
   - **Request body:** paste exactly:
     ```json
     {"event_type":"refresh-snapshot"}
     ```
   - **Headers** → click **`+ ADD`** three times, set:

     | Key | Value |
     |---|---|
     | `Authorization` | `Bearer github_pat_xxx…` |
     | `Accept` | `application/vnd.github+json` |
     | `Content-Type` | `application/json` |

     For the `Authorization` value: the word `Bearer` (capital B), one
     space, then the token. No quotes, no leading/trailing whitespace.
4. Click **TEST RUN** at the bottom-right. Expected response:
   - **Status:** `204 No Content` (green tick)
   - **Headers** include `x-accepted-github-permissions: contents=write`
   - Duration: ~250ms
5. Click **CREATE** at the bottom-right to save and enable the
   schedule. Without this final click the cronjob stays unsaved.

That's it. Within ~10s of step 4 you should see a new run with
`Event = repository_dispatch` at
https://github.com/elysian-12/pythia-engine/actions/workflows/refresh-snapshot.yml.

## What runs after each dispatch

The workflow at `.github/workflows/refresh-snapshot.yml`:

1. Restores the cached `data/` directory (DuckDB + persisted population)
2. Tops up the last 7 days of Kiyotaka data into the DuckDB
   (or 90 days on first cold run)
3. Runs `cargo run -p swarm --bin swarm-backtest` — replays + evolves
   the population, writes the new snapshot
4. Re-bundles the snapshot for Vercel via `node scripts/bundle-snapshot.mjs`
5. Prunes `reports/swarm/<ts>/` dirs older than the last 168 (one week
   of hourly runs) so the repo doesn't bloat
6. Commits the artifacts under the `elysian-12` author so Vercel's
   GitHub integration auto-redeploys with the fresh snapshot

Runtime after the cargo cache warms up: **~2-3 min** per run. Cold
first run: ~10-12 min (cargo workspace compile + 90-day Kiyotaka
scrape). The job timeout is set to 25 min for headroom.

## Verifying it works

Three independent places to check:

1. **cron-job.org dashboard** — the cronjob's "Last execution" column
   shows `204` on success
2. **GitHub Actions tab** — new runs tagged `repository_dispatch`
   appear hourly:
   ```sh
   curl -s "https://api.github.com/repos/elysian-12/pythia-engine/actions/runs?event=repository_dispatch&per_page=5" \
     | python3 -c "import json,sys;[print(r['created_at'],r['status'],r['conclusion'] or '-') for r in json.load(sys.stdin)['workflow_runs']]"
   ```
3. **Production endpoint** — the `generation` field on
   `https://pythia-engine.vercel.app/api/swarm` increments after
   each successful workflow run

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403 Forbidden` on TEST RUN | PAT missing `Contents: write` | Update token permissions per step 1.6 above |
| `401 Unauthorized` | `Authorization` header malformed (missing `Bearer ` prefix, stray newline from paste) | Re-paste the header value cleanly |
| `404 Not Found` | PAT can't see this repo | Re-generate PAT making sure `pythia-engine` is in the "selected repositories" list |
| `422 Unprocessable Entity` | Request body malformed | Ensure body is exactly `{"event_type":"refresh-snapshot"}` and `Content-Type: application/json` is set |
| TEST RUN works but no workflow run appears | The workflow `on: repository_dispatch:` block is missing the matching `types:` | Confirm `.github/workflows/refresh-snapshot.yml` has `repository_dispatch: types: [refresh-snapshot]` |
| Workflow runs but no commit lands | Either no diff (snapshot unchanged) or push step failed | Check the workflow run's "Commit and push" step — `no snapshot changes - nothing to commit` is the no-diff case and is fine |

## Calling the dispatch from elsewhere

The cron-job.org path isn't the only option. Anything that can POST
JSON with a Bearer token works:

**From your laptop right now:**
```sh
curl -i -X POST \
  -H "Authorization: Bearer $GITHUB_DISPATCH_PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/elysian-12/pythia-engine/dispatches \
  -d '{"event_type":"refresh-snapshot"}'
# expected: HTTP/2 204
```

**From a laptop crontab (macOS / Linux):**
```sh
# hourly at minute 5 — staggered off the top of the hour to dodge load
5 * * * * curl -s -X POST -H "Authorization: Bearer $GITHUB_DISPATCH_PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/elysian-12/pythia-engine/dispatches \
  -d '{"event_type":"refresh-snapshot"}'
```

**From the Vercel relay route at `/api/cron/refresh`** — present in
this codebase as a fallback. Requires `GITHUB_DISPATCH_PAT` and
`CRON_SECRET` set as Vercel env vars. Useful if you want to centralise
the GitHub PAT in one place (Vercel) instead of pasting it into
cron-job.org. Vercel Hobby cron is daily-only, so the route is
manually-fired or hit by an external scheduler — not auto-cron.

**From the GitHub Actions UI directly** — the `workflow_dispatch:`
trigger gives you a **Run workflow** button at
https://github.com/elysian-12/pythia-engine/actions/workflows/refresh-snapshot.yml.
Use this any time before a demo to guarantee a fresh snapshot.

## Cost

| Component | Cadence | Free tier | Cost |
|---|---|---|---|
| cron-job.org | Hourly (24/day) | unlimited free | $0 |
| GitHub Actions runner-min | ~2 min/run × 24 = ~48 min/day = ~1,440 min/month | 2,000 min/month free on private; unlimited on public | $0 |
| GitHub repo storage | 1-2 KB/day net (snapshot diffs after pruning) | 1 GB free | $0 |
| Vercel deploys | Auto on commit | 100/day free | $0 |

Total: **$0/month** for hourly refreshes on a private repo. Bumping
to every-15-min would still fit under the free tiers. Switching to
every-minute would exceed GitHub Actions' free quota on a private
repo only.

## When to bypass this and use a different architecture

Three signals that you've outgrown the cron-job.org → GitHub Actions
loop:

1. **You want sub-minute evolution** — at that cadence the cron
   commit churn becomes a real problem (multi-MB/day repo growth).
   Switch to a Railway / Fly.io daemon running `pythia-swarm-live`
   24/7, posting snapshots to a `/snapshot` HTTP endpoint that
   Vercel polls.

2. **You want continuous evolution between user actions** — same
   answer; the GitHub Actions loop is batched, a daemon is real-time.

3. **You're hitting Kiyotaka rate limits** — at scale, top-up data
   per cron run starts to interfere with live `/api/signals` polls
   from the same IP. Move ingest to a separate daemon with its own
   API quota.

For a research prototype + demo, the cron-job.org architecture is
right-sized.
