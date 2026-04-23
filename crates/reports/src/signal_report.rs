//! Per-signal report (rendered on close).

use domain::signal::{Signal, Trade};
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignalReport {
    pub signal: Signal,
    pub trade: Trade,
    pub counterfactual_mid_only_r: Option<f64>,
}

impl SignalReport {
    pub fn render_markdown(&self) -> String {
        let mut s = String::new();
        let _ = writeln!(s, "# Signal `{}` — {}", self.signal.id, self.signal.market_name);
        let _ = writeln!(s, "\n## Fire context\n");
        let _ = writeln!(s, "- When: {}", self.signal.ts);
        let _ = writeln!(s, "- Asset: `{:?}`", self.signal.asset);
        let _ = writeln!(s, "- Direction: `{:?}`", self.signal.direction);
        let _ = writeln!(s, "- SWP: {:.4}", self.signal.swp);
        let _ = writeln!(s, "- Mid: {:.4}", self.signal.mid);
        let _ = writeln!(s, "- Edge: {:+.4}", self.signal.edge);
        let _ = writeln!(s, "- IS(PM): {:.3}", self.signal.is_pm);
        let _ = writeln!(s, "- Granger F: {:.2}", self.signal.granger_f);
        let _ = writeln!(s, "- Gini: {:.2}", self.signal.gini);
        let _ = writeln!(s, "- Conviction: {}/100", self.signal.conviction);
        let _ = writeln!(s, "\n## Trade ledger\n");
        let _ = writeln!(s, "- Entry: {} @ {:.2}", self.trade.entry_ts, self.trade.entry_price);
        if let (Some(ex), Some(px)) = (self.trade.exit_ts, self.trade.exit_price) {
            let _ = writeln!(s, "- Exit:  {} @ {:.2}", ex, px);
        }
        let _ = writeln!(s, "- Fees: {:.2}", self.trade.fees);
        let _ = writeln!(s, "- Funding: {:+.2}", self.trade.funding_paid);
        let _ = writeln!(s, "- Slippage: {:.2}", self.trade.slippage);
        if let Some(r) = self.trade.r_multiple {
            let _ = writeln!(s, "- **R-multiple: {r:+.2}**");
        }
        if let Some(p) = self.trade.pnl_usd {
            let _ = writeln!(s, "- **PnL USD: {p:+.2}**");
        }
        if let Some(r) = self.counterfactual_mid_only_r {
            let _ = writeln!(s, "\n## Counterfactual\n- Raw-mid-only signal would have closed at R={r:+.2}");
        }
        s
    }
}
