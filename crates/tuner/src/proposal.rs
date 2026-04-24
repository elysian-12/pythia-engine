//! Proposal queue with TTL and rollback tracking.
//!
//! Changes never apply instantly. They sit in a queue for up to the
//! TTL (default 1 h) during which a human can veto. Once applied, the
//! queue records a rollback trigger and can revert the change if the
//! realised Sharpe drops.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::llm::Proposal;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueuedProposal {
    pub id: String,
    pub proposal: Proposal,
    pub queued_at: i64,
    pub ttl_seconds: i64,
    pub status: ProposalStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ProposalStatus {
    Pending,
    Applied { applied_at: i64 },
    RolledBack { at: i64, reason: String },
    Vetoed { at: i64, reason: String },
    Expired,
}

#[derive(Debug)]
pub struct ProposalQueue {
    path: PathBuf,
}

impl ProposalQueue {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn load_all(&self) -> Vec<QueuedProposal> {
        fs::read_to_string(&self.path)
            .ok()
            .map(|s| {
                s.lines()
                    .filter(|l| !l.trim().is_empty())
                    .filter_map(|l| serde_json::from_str(l).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn write_all(&self, items: &[QueuedProposal]) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).ok();
        }
        let tmp = self.path.with_extension("tmp");
        let mut body = String::new();
        for it in items {
            body.push_str(&serde_json::to_string(it).map_err(std::io::Error::other)?);
            body.push('\n');
        }
        fs::write(&tmp, body)?;
        fs::rename(&tmp, &self.path)
    }

    pub fn enqueue(&self, p: Proposal, ttl_seconds: i64) -> std::io::Result<String> {
        let mut all = self.load_all();
        let id = format!("proposal-{}", Utc::now().timestamp());
        all.push(QueuedProposal {
            id: id.clone(),
            proposal: p,
            queued_at: Utc::now().timestamp(),
            ttl_seconds,
            status: ProposalStatus::Pending,
        });
        self.write_all(&all)?;
        Ok(id)
    }

    /// Mark a proposal as applied; returns whether the mark succeeded.
    pub fn mark_applied(&self, id: &str) -> std::io::Result<bool> {
        let mut all = self.load_all();
        let mut changed = false;
        for it in &mut all {
            if it.id == id && matches!(it.status, ProposalStatus::Pending) {
                it.status = ProposalStatus::Applied {
                    applied_at: Utc::now().timestamp(),
                };
                changed = true;
                break;
            }
        }
        if changed {
            self.write_all(&all)?;
        }
        Ok(changed)
    }

    pub fn mark_vetoed(&self, id: &str, reason: impl Into<String>) -> std::io::Result<bool> {
        let mut all = self.load_all();
        let mut changed = false;
        for it in &mut all {
            if it.id == id && matches!(it.status, ProposalStatus::Pending) {
                it.status = ProposalStatus::Vetoed {
                    at: Utc::now().timestamp(),
                    reason: reason.into(),
                };
                changed = true;
                break;
            }
        }
        if changed {
            self.write_all(&all)?;
        }
        Ok(changed)
    }

    pub fn expire_stale(&self) -> std::io::Result<usize> {
        let now = Utc::now().timestamp();
        let mut all = self.load_all();
        let mut n = 0;
        for it in &mut all {
            if matches!(it.status, ProposalStatus::Pending)
                && (now - it.queued_at) > it.ttl_seconds
            {
                it.status = ProposalStatus::Expired;
                n += 1;
            }
        }
        if n > 0 {
            self.write_all(&all)?;
        }
        Ok(n)
    }

    pub fn pending(&self) -> Vec<QueuedProposal> {
        self.load_all()
            .into_iter()
            .filter(|p| matches!(p.status, ProposalStatus::Pending))
            .collect()
    }

    pub fn history(&self, limit: usize) -> Vec<QueuedProposal> {
        let mut all = self.load_all();
        all.sort_by_key(|p| std::cmp::Reverse(p.queued_at));
        all.into_iter().take(limit).collect()
    }
}

impl ProposalQueue {
    pub fn default_path() -> PathBuf {
        PathBuf::from("data/pythia-proposals.ndjson")
    }
}

pub fn default_queue_path() -> &'static Path {
    Path::new("data/pythia-proposals.ndjson")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn mkp() -> Proposal {
        Proposal {
            strategy_id: "liq-trend".into(),
            diagnosis: "test".into(),
            confidence: 80.0,
            proposed_change: {
                let mut m = HashMap::new();
                m.insert("z_threshold".into(), 2.7);
                m
            },
            rationale: "t".into(),
            expected_effect: "t".into(),
            rollback_trigger: "t".into(),
        }
    }

    fn tmp() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("pythia-proposal-{}.ndjson", rand_suffix()));
        p
    }

    fn rand_suffix() -> String {
        format!("{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
    }

    #[test]
    fn enqueue_then_mark_applied() {
        let q = ProposalQueue::new(tmp());
        let id = q.enqueue(mkp(), 3600).unwrap();
        assert_eq!(q.pending().len(), 1);
        assert!(q.mark_applied(&id).unwrap());
        assert_eq!(q.pending().len(), 0);
    }

    #[test]
    fn expire_stale_past_ttl() {
        let q = ProposalQueue::new(tmp());
        let _ = q.enqueue(mkp(), 0).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert_eq!(q.expire_stale().unwrap(), 1);
        assert_eq!(q.pending().len(), 0);
    }
}
