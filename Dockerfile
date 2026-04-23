## ──────────────────────────────────────────────────────────────────────
##  PolyEdge — multi-stage image with Rust API + Next.js web
## ──────────────────────────────────────────────────────────────────────

## 1. Rust builder
FROM rust:1.88-slim AS rust-build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml rust-toolchain.toml rustfmt.toml ./
COPY crates ./crates
COPY fixtures ./fixtures
# Pre-build workspace for deps cache.
RUN cargo build --release -p api --bin pythia


## 2. Node builder
FROM node:20-slim AS node-build
WORKDIR /app
COPY apps/web/package.json ./apps/web/
WORKDIR /app/apps/web
RUN npm install --no-audit --no-fund --loglevel=error
COPY apps/web .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


## 3. Runtime
FROM debian:bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# Install Node for serving the Next.js app (its standalone output would be
# ideal long-term, but the default `npm start` is the simplest first cut).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust-build /app/target/release/pythia /usr/local/bin/pythia
COPY --from=node-build /app/apps/web /app/web
COPY reports /app/reports

ENV PYTHIA_BIND=0.0.0.0:8080
ENV PYTHIA_DB=/app/data/pythia.duckdb
EXPOSE 3000 8080

WORKDIR /app
COPY scripts/run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh
CMD ["/usr/local/bin/run.sh"]
