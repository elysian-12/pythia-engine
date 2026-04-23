import { getMarkets, getOverview, getRate } from "@/lib/api";

export const dynamic = "force-dynamic";

function Card({
  title,
  value,
  sub,
}: {
  title: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="panel p-4">
      <div className="text-xs uppercase tracking-wider text-mist">{title}</div>
      <div className="mt-2 text-2xl font-semibold num">{value}</div>
      {sub ? <div className="mt-1 text-xs text-mist">{sub}</div> : null}
    </div>
  );
}

export default async function Page() {
  const [overview, markets, rate] = await Promise.all([
    getOverview(),
    getMarkets(),
    getRate(),
  ]);

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card
          title="BTC hourly candles"
          value={overview?.candles_btc ?? 0}
        />
        <Card
          title="ETH hourly candles"
          value={overview?.candles_eth ?? 0}
        />
        <Card
          title="Tracked traders"
          value={overview?.trader_profiles ?? 0}
        />
        <Card
          title="Tracked markets"
          value={overview?.market_summaries ?? 0}
        />
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card title="Funding points" value={overview?.funding ?? 0} />
        <Card title="OI points" value={overview?.oi ?? 0} />
        <Card title="Liquidation events" value={overview?.liquidations ?? 0} />
        <Card
          title="Signals fired"
          value={overview?.signals ?? 0}
          sub={`Paper trades: ${overview?.trades ?? 0}`}
        />
      </section>

      <section className="panel p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-mist">
              Rate budget
            </div>
            <div className="text-lg num mt-1">
              {rate?.used ?? 0}/{rate?.limit || "—"}
            </div>
          </div>
          <div className="text-xs text-mist">
            Remaining: <span className="num">{rate?.remaining ?? "—"}</span>
          </div>
        </div>
      </section>

      <section className="panel p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-mist">
            Active tracked markets
          </div>
          <div className="text-xs text-mist">
            {markets?.length ?? 0} conditions
          </div>
        </div>
        <ul className="mt-3 grid grid-cols-1 gap-1 text-xs font-mono text-slate-400 max-h-96 overflow-auto">
          {(markets ?? []).slice(0, 100).map((m) => (
            <li
              key={m.condition_id}
              className="truncate border-b border-edge/50 py-1"
            >
              {m.condition_id}
            </li>
          ))}
          {(markets ?? []).length === 0 ? (
            <li className="text-mist">
              Ingesting — markets will appear once crypto-relevant positions are
              discovered in the top wallets.
            </li>
          ) : null}
        </ul>
      </section>

      <section className="panel p-4">
        <div className="text-xs uppercase tracking-wider text-mist">
          Methodology
        </div>
        <p className="mt-2 text-sm text-slate-300">
          PolyEdge computes a <em>skill-weighted probability</em> (SWP) for each
          crypto-relevant Polymarket market using the Kiyotaka leaderboard,
          trader profile, and positions endpoints. A signal fires when the
          gap between SWP and the raw mid price is wide, and when the
          prediction market demonstrably leads the crypto-price series — tested
          via a lag-4 <em>Granger F-statistic</em> and the
          variance-decomposition proxy for Hasbrouck&apos;s{" "}
          <em>information share</em>, both gated by an Engle–Granger
          cointegration check.
        </p>
        <p className="mt-2 text-sm text-slate-300">
          Trades are paper-executed on BTC or ETH perps with realistic taker
          fees, slippage and funding. Every signal is recorded to the DuckDB
          store with its upstream data provenance.
        </p>
      </section>
    </div>
  );
}
