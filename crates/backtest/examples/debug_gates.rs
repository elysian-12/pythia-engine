//! Diagnostic: counts gate rejections across the synthetic scenario.

use backtest::synthetic;
use domain::crypto::Asset;
use signal_engine::{evaluate_with_reason, RejectReason, SignalConfig};
use std::collections::HashMap;

fn main() {
    use econometrics::{granger_f, information_share_proxy, zscore_last};
    eprintln!("debug_gates v2");
    let scn = synthetic::generate(500, 1_234, Asset::Btc);
    let cfg = SignalConfig {
        min_edge: 0.02,
        min_is_pm: 0.01,
        min_granger_f: 1.0,
        min_gini: 0.4,
        max_crypto_z: 5.0,
        econ_lookback: 80,
        z_window: 20,
        granger_lag: 4,
        ..Default::default()
    };
    let mut tally: HashMap<String, usize> = HashMap::new();
    let mut first_numeric = true;
    for st in &scn.states {
        let label = match evaluate_with_reason(st, &cfg) {
            Ok(_) => "FIRED".to_string(),
            Err(r) => format!("{:?}", classify(&r)),
        };
        if label == "\"NumericFailure\"" && first_numeric {
            first_numeric = false;
            let need = cfg.econ_lookback;
            let pmw = &st.pm_series[st.pm_series.len() - need..];
            let cxw = &st.crypto_series[st.crypto_series.len() - need..];
            eprintln!("pm len={} cx len={}", pmw.len(), cxw.len());
            eprintln!("pm first 5 = {:?}", &pmw[..5]);
            eprintln!("cx first 5 = {:?}", &cxw[..5]);
            match information_share_proxy(pmw, cxw, cfg.granger_lag) {
                Ok(is) => eprintln!("info_share ok: {:?}", is),
                Err(e) => eprintln!("info_share err: {:?}", e),
            }
            match granger_f(cxw, pmw, cfg.granger_lag) {
                Ok(g) => eprintln!("granger ok: F={}", g.f),
                Err(e) => eprintln!("granger err: {:?}", e),
            }
            match zscore_last(&st.crypto_response, cfg.z_window) {
                Some(z) => eprintln!("zscore ok: {}", z),
                None => eprintln!("zscore None"),
            }
        }
        *tally.entry(label).or_insert(0) += 1;
    }
    let mut v: Vec<_> = tally.into_iter().collect();
    v.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    for (k, n) in v {
        println!("{n:>4}  {k}");
    }
}

fn classify(r: &RejectReason) -> String {
    match r {
        RejectReason::SmallEdge(_) => "SmallEdge".into(),
        RejectReason::LowGini(_) => "LowGini".into(),
        RejectReason::IsPmTooLow(_) => "IsPmTooLow".into(),
        RejectReason::GrangerWeak(_) => "GrangerWeak".into(),
        RejectReason::GrangerInsignificant => "GrangerInsignificant".into(),
        RejectReason::CryptoAlreadyMoved(_) => "CryptoAlreadyMoved".into(),
        RejectReason::InsufficientHistory { .. } => "InsufficientHistory".into(),
        RejectReason::NoMapping => "NoMapping".into(),
        RejectReason::MissingInputs => "MissingInputs".into(),
        RejectReason::NumericFailure => "NumericFailure".into(),
    }
}
