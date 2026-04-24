//! Strict parameter bounds — the LLM can never propose anything outside
//! these ranges. Enforced both as a pre-prompt constraint and a
//! post-response validation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ParamBounds {
    pub min: f64,
    pub max: f64,
    pub step: f64,
}

impl ParamBounds {
    pub fn new(min: f64, max: f64, step: f64) -> Self {
        Self { min, max, step }
    }

    pub fn clamp(&self, v: f64) -> f64 {
        let v = v.clamp(self.min, self.max);
        if self.step > 0.0 {
            let steps = ((v - self.min) / self.step).round();
            (self.min + steps * self.step).clamp(self.min, self.max)
        } else {
            v
        }
    }

    pub fn is_valid(&self, v: f64) -> bool {
        v >= self.min && v <= self.max
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Bounds {
    pub params: HashMap<String, ParamBounds>,
}

impl Bounds {
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, key: impl Into<String>, bound: ParamBounds) -> Self {
        self.params.insert(key.into(), bound);
        self
    }

    /// Default bounds for the current flagship configuration.
    pub fn default_liq_trend() -> Self {
        Self::new()
            .with("z_threshold", ParamBounds::new(2.0, 3.5, 0.1))
            .with("risk_fraction", ParamBounds::new(0.003, 0.015, 0.001))
            .with("stop_atr_mult", ParamBounds::new(1.0, 2.5, 0.1))
            .with("tp_atr_mult", ParamBounds::new(2.0, 5.0, 0.25))
            .with("cooldown_hours", ParamBounds::new(3.0, 24.0, 1.0))
    }

    pub fn get(&self, name: &str) -> Option<&ParamBounds> {
        self.params.get(name)
    }

    /// Validate a proposed changeset. Any out-of-bounds entry is dropped
    /// (and returned as a rejection reason). In-bounds entries are
    /// snapped to the step grid.
    pub fn sanitise(
        &self,
        proposed: &HashMap<String, f64>,
    ) -> (HashMap<String, f64>, Vec<String>) {
        let mut ok: HashMap<String, f64> = HashMap::new();
        let mut rejects: Vec<String> = Vec::new();
        for (k, v) in proposed {
            match self.params.get(k) {
                Some(b) if b.is_valid(*v) => {
                    ok.insert(k.clone(), b.clamp(*v));
                }
                Some(b) => rejects.push(format!(
                    "`{k}` = {v} outside [{}, {}]",
                    b.min, b.max
                )),
                None => rejects.push(format!("unknown parameter `{k}`")),
            }
        }
        (ok, rejects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_snaps_to_step() {
        let b = ParamBounds::new(2.0, 3.0, 0.25);
        assert!((b.clamp(2.3) - 2.25).abs() < 1e-9);
        assert!((b.clamp(5.0) - 3.0).abs() < 1e-9);
        assert!((b.clamp(0.0) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn sanitise_rejects_out_of_bounds() {
        let b = Bounds::default_liq_trend();
        let mut proposed = HashMap::new();
        proposed.insert("z_threshold".into(), 5.0);
        proposed.insert("risk_fraction".into(), 0.01);
        proposed.insert("nonsense".into(), 42.0);
        let (ok, rejects) = b.sanitise(&proposed);
        assert!(ok.contains_key("risk_fraction"));
        assert!(!ok.contains_key("z_threshold"));
        assert_eq!(rejects.len(), 2);
    }
}
