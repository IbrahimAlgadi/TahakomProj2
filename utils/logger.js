'use strict';

/**
 * Shared logger factory + AsyncLocalStorage trace helpers.
 *
 * Usage (any service):
 *   const { createLogger, runWithTrace, newTraceId } = require('./utils/logger');
 *   const logger = createLogger({ service: 'MyService' });
 *
 *   // Wrap a job/request so every log call inside stamps the same traceId:
 *   await runWithTrace({ traceId: newTraceId(), jobId: job.id, camera: '1' }, async () => {
 *     logger.info('Starting job');                  // → { traceId, jobId, camera, ... }
 *     await someHelper();                           // helper logs also get traceId automatically
 *   });
 *
 * Express HTTP tracing (mount before routes):
 *   const { traceMiddleware } = require('./utils/logger');
 *   app.use(traceMiddleware);
 */

require('dotenv').config();
const { AsyncLocalStorage } = require('async_hooks');
const { createLogger: winstonCreateLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ─── Trace context storage ─────────────────────────────────────────────────

const als = new AsyncLocalStorage();

/**
 * Generate a new UUID v4 trace ID.
 */
function newTraceId() {
    return uuidv4();
}

/**
 * Run `fn` inside an AsyncLocalStorage context that carries `context`
 * (e.g. { traceId, jobId, camera }).  All logger calls executed inside
 * `fn` (including async descendants) will have `context` fields merged
 * automatically into the log entry.
 *
 * @param {Object} context   Arbitrary key/value pairs to stamp on log lines.
 * @param {Function} fn      Async or sync function to run.
 * @returns {*}              Whatever `fn` returns.
 */
function runWithTrace(context, fn) {
    return als.run(context, fn);
}

/**
 * Return the current trace context object, or an empty object when called
 * outside of a `runWithTrace` scope.
 */
function getTraceContext() {
    return als.getStore() || {};
}

/**
 * Return only the `traceId` from the current trace context (convenience).
 */
function getTraceId() {
    const store = als.getStore();
    return store ? store.traceId : undefined;
}

/**
 * Add a field to the **current** trace context in-place.
 * No-op when called outside a `runWithTrace` scope.
 *
 * @param {string} key
 * @param {*}      value
 */
function addTraceField(key, value) {
    const store = als.getStore();
    if (store) store[key] = value;
}

// ─── Winston trace format ──────────────────────────────────────────────────

/**
 * Custom Winston format that merges the current ALS trace context into each
 * log entry.  Fields are spread so they appear at the top level alongside
 * `timestamp`, `level`, and `message`.
 */
const traceFormat = format((info) => {
    const ctx = als.getStore();
    if (ctx && Object.keys(ctx).length > 0) {
        Object.assign(info, ctx);
    }
    return info;
});

// ─── Logger factory ────────────────────────────────────────────────────────

const LOG_LEVEL     = process.env.LOG_LEVEL      || 'info';
const LOG_DIRECTORY = process.env.LOG_DIRECTORY  || 'logs';
const LOG_MAX_SIZE  = process.env.LOG_MAX_SIZE   || '20m';
const LOG_MAX_FILES = process.env.LOG_MAX_FILES  || '14d';

// Root log dir
if (!fs.existsSync(LOG_DIRECTORY)) {
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
}

// Audit files go here — keeps the root log folder clean
const AUDIT_DIR = `${LOG_DIRECTORY}/.audit`;
if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

/**
 * Build the console transport format (dev/TTY only).
 */
function buildConsoleFormat() {
    return format.combine(format.colorize(), format.simple());
}

/**
 * Create a Winston logger bound to `service`.
 *
 * @param {{ service: string, logFile?: string }} options
 *   service  — identifies the component in every JSON log line (`service` field)
 *   logFile  — optional pipeline/group name used as the FILE prefix.
 *              Multiple services can share one log file by passing the same
 *              logFile value (e.g. all video-USB helpers pass
 *              logFile: 'video-usb-pipeline').
 *              Defaults to `service` when omitted.
 *
 * Writes:
 *   logs/<logFile>-app-%DATE%.log   — combined (all levels)
 *   logs/<logFile>-error-%DATE%.log — errors only
 *   console/stdout                  — only when attached to a real TTY (dev).
 *                                     Under PM2 (no TTY) the console transport
 *                                     is skipped, eliminating the duplicate
 *                                     *-out.log / *-error.log PM2 files.
 */
function createLogger({ service, logFile } = {}) {
    const svcName   = service  || 'app';
    const fileGroup = logFile  || svcName;

    const baseFormat = format.combine(
        format.timestamp(),
        traceFormat(),
        format.label({ label: svcName }),
        format.json()
    );

    const fileTransports = [
        new transports.DailyRotateFile({
            filename:  `${LOG_DIRECTORY}/${fileGroup}-error-%DATE%.log`,
            auditFile: `${AUDIT_DIR}/${fileGroup}-error-audit.json`,
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxSize: LOG_MAX_SIZE,
            maxFiles: LOG_MAX_FILES,
            zippedArchive: true,
        }),
        new transports.DailyRotateFile({
            filename:  `${LOG_DIRECTORY}/${fileGroup}-app-%DATE%.log`,
            auditFile: `${AUDIT_DIR}/${fileGroup}-app-audit.json`,
            datePattern: 'YYYY-MM-DD',
            maxSize: LOG_MAX_SIZE,
            maxFiles: LOG_MAX_FILES,
            zippedArchive: true,
        }),
    ];

    // Console only in interactive terminals (local dev).
    // PM2 sets isTTY = false/undefined → no console transport →
    // no duplicate -out.log / -error.log files.
    if (process.stdout.isTTY) {
        fileTransports.push(new transports.Console({ format: buildConsoleFormat() }));
    }

    return winstonCreateLogger({
        level: LOG_LEVEL,
        format: baseFormat,
        defaultMeta: { service: svcName },
        transports: fileTransports,
    });
}

// ─── Express middleware ────────────────────────────────────────────────────

/**
 * Express middleware that attaches a traceId to every request.
 *
 * - Reads `X-Trace-Id` or `X-Request-Id` request headers when present
 *   (useful when an upstream caller already assigned an ID).
 * - Falls back to generating a new UUID v4.
 * - Echoes the traceId back in the `X-Trace-Id` response header.
 * - Wraps `next()` inside `runWithTrace` so every log call that happens
 *   during the request lifecycle (including inside route handlers and shared
 *   service helpers) automatically carries the traceId.
 *
 * Mount before any routes:
 *   app.use(traceMiddleware);
 */
function traceMiddleware(req, res, next) {
    const traceId =
        req.headers['x-trace-id'] ||
        req.headers['x-request-id'] ||
        newTraceId();

    res.setHeader('X-Trace-Id', traceId);

    runWithTrace({ traceId }, next);
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
    createLogger,
    newTraceId,
    runWithTrace,
    getTraceContext,
    getTraceId,
    addTraceField,
    traceMiddleware,
};
