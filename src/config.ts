export const PORT = Number(process.env.PORT) || 3000;

export const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS) || 5000;

export const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS) || 15000;

export const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES) || 1024 * 1024;

/**
 * The ClinePass provider + model that the HintLab agent uses. These default to
 * the same provider/model the Cline CLI is authenticated with, so no API key is
 * needed in the repo or environment: the SDK reads credentials from ~/.cline.
 */
export const HINTLAB_PROVIDER_ID = process.env.HINTLAB_PROVIDER_ID || "cline-pass";

export const HINTLAB_MODEL_ID = process.env.HINTLAB_MODEL_ID || "cline-pass/deepseek-v4-pro";

/** How long an agent turn (start/send) may run before we consider it stuck. */
export const AGENT_TURN_TIMEOUT_MS = Number(process.env.AGENT_TURN_TIMEOUT_MS) || 300000;

/** Session TTL: idle sessions (and their temp workdirs) are cleaned up after this. */
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 30 * 60 * 1000;

/** How often the session cleanup loop runs. */
export const SESSION_CLEANUP_INTERVAL_MS = Number(process.env.SESSION_CLEANUP_INTERVAL_MS) || 60 * 1000;

/** SSE heartbeat interval. */
export const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 15000;

