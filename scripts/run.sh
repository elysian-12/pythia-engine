#!/usr/bin/env bash
# Supervisor: run the Rust API and the Next.js web app together.
set -eu
mkdir -p /app/data /app/reports
: "${PYTHIA_API:=http://localhost:8080}"

# Start the Rust API.
pythia &
API_PID=$!

# Start the Next.js server pointed at the API.
cd /app/web
PYTHIA_API="${PYTHIA_API}" npm run start -- -p 3000 &
WEB_PID=$!

trap "kill ${API_PID} ${WEB_PID}" INT TERM
wait -n ${API_PID} ${WEB_PID}
status=$?
kill ${API_PID} ${WEB_PID} 2>/dev/null || true
exit ${status}
