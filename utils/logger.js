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

/**
 * Ensure the log directory exists (mirrors the existing behaviour in
 * DashboardReportingBackend.js).
 */
if (!fs.existsSync(LOG_DIRECTORY)) {
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
}

/**
 * Build the console transport format.
 * Under PM2 (or any non-TTY context) colorize is disabled so that the
 * captured `-out.log` / `-error.log` files stay clean.
 */
function buildConsoleFormat() {
    if (process.stdout.isTTY) {
        return format.combine(format.colorize(), format.simple());
    }
    return format.combine(format.timestamp(), format.simple());
}

/**
 * Create a Winston logger bound to `service`.
 *
 * Writes:
 *   logs/<service>-app-%DATE%.log    — combined (all levels)
 *   logs/<service>-error-%DATE%.log  — error level only
 *   console / stdout                 — captured by PM2 into -out/-error.log
 *
 * Every entry carries: timestamp, level, service, message, and any fields
 * currently held in the AsyncLocalStorage trace context (traceId, jobId, …).
 *
 * @param {{ service: string }} options
 * @returns {import('winston').Logger}
 */
function createLogger({ service } = {}) {
    const svcName = service || 'app';

    const baseFormat = format.combine(
        format.timestamp(),
        traceFormat(),
        format.label({ label: svcName }),
        format.json()
    );

    return winstonCreateLogger({
        level: LOG_LEVEL,
        format: baseFormat,
        defaultMeta: { service: svcName },
        transports: [
            new transports.DailyRotateFile({
                filename: `${LOG_DIRECTORY}/${svcName}-error-%DATE%.log`,
                datePattern: 'YYYY-MM-DD',
                level: 'error',
                maxSize: LOG_MAX_SIZE,
                maxFiles: LOG_MAX_FILES,
                zippedArchive: true,
            }),
            new transports.DailyRotateFile({
                filename: `${LOG_DIRECTORY}/${svcName}-app-%DATE%.log`,
                datePattern: 'YYYY-MM-DD',
                maxSize: LOG_MAX_SIZE,
                maxFiles: LOG_MAX_FILES,
                zippedArchive: true,
            }),
            new transports.Console({
                format: buildConsoleFormat(),
            }),
        ],
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
