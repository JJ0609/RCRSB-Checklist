// ─────────────────────────────────────────────────────────────
// SYNC CONFIG — the only thing you need to edit before deploying.
// Point this at your deployed Cloudflare Worker (see README.md).
// Leave it as-is to run in local-only mode (no cross-device sync).
// ─────────────────────────────────────────────────────────────
const SYNC_API_BASE = "/https://rcrsb-commissioning-sync.jjcampbell06092004.workers.dev/";
const SYNC_POLL_MS = 5000;
