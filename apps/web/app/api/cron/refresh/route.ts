import { NextResponse } from "next/server";

// Vercel-cron-fired endpoint that POSTs to GitHub's repository_dispatch
// API to trigger the swarm-snapshot refresh workflow. Reliable
// alternative to GitHub Actions' native cron (which is documented as
// "may be delayed during periods of high loads" and in practice
// drops runs entirely).
//
// Authorisation:
//   - Vercel sends an `Authorization: Bearer ${process.env.CRON_SECRET}`
//     header on its scheduled invocations. We require it. This blocks
//     random internet traffic from triggering refreshes.
//   - The route then uses `GITHUB_DISPATCH_PAT` (a fine-grained PAT
//     with `Actions: Read and write` scoped to pythia-engine) to call
//     the GitHub REST API.
//
// Schedule lives in `apps/web/vercel.json`. Default cadence is hourly
// at minute 5; bump up via `vercel.json` if you want minute-fresh.
//
// See: https://vercel.com/docs/cron-jobs

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_OWNER = "elysian-12";
const REPO_NAME = "pythia-engine";
const EVENT_TYPE = "refresh-snapshot";

export async function GET(req: Request) {
  // Vercel signs cron invocations with the CRON_SECRET env var. Reject
  // anything else — without this anyone could DoS the GitHub dispatch
  // endpoint with public traffic.
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const authHeader = req.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== expectedAuth
  ) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const pat = process.env.GITHUB_DISPATCH_PAT;
  if (!pat) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "GITHUB_DISPATCH_PAT not set. Generate a fine-grained PAT scoped to elysian-12/pythia-engine with Actions: Read+Write, add it to Vercel env vars, redeploy.",
      },
      { status: 500 },
    );
  }

  // Fire the repository_dispatch. GitHub returns 204 on success.
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/dispatches`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "pythia-cron",
      },
      body: JSON.stringify({
        event_type: EVENT_TYPE,
        client_payload: {
          source: "vercel-cron",
          fired_at: new Date().toISOString(),
        },
      }),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `dispatch fetch failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  if (res.status === 204) {
    return NextResponse.json({
      ok: true,
      dispatched: EVENT_TYPE,
      target: `${REPO_OWNER}/${REPO_NAME}`,
      ts: new Date().toISOString(),
    });
  }

  // Surface the GitHub error body so the user can debug PAT scope
  // problems straight from the Vercel logs.
  const body = await res.text().catch(() => "");
  return NextResponse.json(
    {
      ok: false,
      error: `github dispatch HTTP ${res.status}`,
      body: body.slice(0, 500),
    },
    { status: 502 },
  );
}
