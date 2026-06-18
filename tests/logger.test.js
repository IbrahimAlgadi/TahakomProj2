'use strict';

const {
    createLogger,
    newTraceId,
    runWithTrace,
    getTraceContext,
    getTraceId,
    addTraceField,
    traceMiddleware,
} = require('../utils/logger');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Capture one log entry by wiring a temporary in-memory Writable stream.
 * Returns the first info object the Winston logger emits.
 */
function captureLogEntry(loggerInstance, fn) {
    const { Writable } = require('stream');
    return new Promise((resolve) => {
        const chunks = [];
        const writable = new Writable({
            write(chunk, _enc, cb) {
                chunks.push(chunk.toString());
                resolve(JSON.parse(chunks.join('')));
                cb();
            },
        });
        loggerInstance.add(
            new (require('winston').transports.Stream)({ stream: writable })
        );
        fn();
    });
}

// ─── newTraceId ───────────────────────────────────────────────────────────────

describe('newTraceId', () => {
    it('returns a UUID v4 string', () => {
        const id = newTraceId();
        expect(typeof id).toBe('string');
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
    });

    it('returns a different ID each call', () => {
        expect(newTraceId()).not.toBe(newTraceId());
    });
});

// ─── runWithTrace / getTraceContext / getTraceId ───────────────────────────────

describe('runWithTrace', () => {
    it('makes context available inside fn via getTraceContext', async () => {
        const traceId = newTraceId();
        await runWithTrace({ traceId, jobId: 'job-1' }, async () => {
            const ctx = getTraceContext();
            expect(ctx.traceId).toBe(traceId);
            expect(ctx.jobId).toBe('job-1');
        });
    });

    it('getTraceId returns traceId from current context', async () => {
        const traceId = newTraceId();
        await runWithTrace({ traceId }, async () => {
            expect(getTraceId()).toBe(traceId);
        });
    });

    it('getTraceContext returns empty object outside runWithTrace', () => {
        expect(getTraceContext()).toEqual({});
    });

    it('getTraceId returns undefined outside runWithTrace', () => {
        expect(getTraceId()).toBeUndefined();
    });

    it('inner context does not leak to outer scope', async () => {
        const outer = newTraceId();
        const inner = newTraceId();
        await runWithTrace({ traceId: outer }, async () => {
            await runWithTrace({ traceId: inner }, async () => {
                expect(getTraceId()).toBe(inner);
            });
            expect(getTraceId()).toBe(outer);
        });
    });
});

// ─── addTraceField ────────────────────────────────────────────────────────────

describe('addTraceField', () => {
    it('adds a field to the current trace context', async () => {
        await runWithTrace({ traceId: newTraceId() }, async () => {
            addTraceField('camera', 'CAM_3');
            expect(getTraceContext().camera).toBe('CAM_3');
        });
    });

    it('is a no-op outside runWithTrace', () => {
        expect(() => addTraceField('foo', 'bar')).not.toThrow();
    });
});

// ─── createLogger + trace format ─────────────────────────────────────────────

describe('createLogger', () => {
    it('creates a Winston logger without error', () => {
        const log = createLogger({ service: 'test-service' });
        expect(typeof log.info).toBe('function');
        expect(typeof log.error).toBe('function');
        expect(typeof log.close).toBe('function');
    });

    it('injects traceId into log entries inside runWithTrace', async () => {
        const log = createLogger({ service: 'trace-test' });
        const traceId = newTraceId();

        const entry = await captureLogEntry(log, () => {
            runWithTrace({ traceId, jobId: 'j-42' }, () => {
                log.info('hello from trace');
            });
        });

        expect(entry.traceId).toBe(traceId);
        expect(entry.jobId).toBe('j-42');
        expect(entry.message).toBe('hello from trace');
        expect(entry.service).toBe('trace-test');

        log.close();
    });

    it('emits log entries without traceId outside runWithTrace', async () => {
        const log = createLogger({ service: 'no-trace-test' });

        const entry = await captureLogEntry(log, () => {
            log.info('no trace here');
        });

        expect(entry.traceId).toBeUndefined();
        expect(entry.message).toBe('no trace here');

        log.close();
    });
});

// ─── traceMiddleware ──────────────────────────────────────────────────────────

describe('traceMiddleware', () => {
    function makeReqRes(headers = {}) {
        const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
        const req = { headers };
        return { req, res };
    }

    it('generates a traceId and echoes it in X-Trace-Id header', (done) => {
        const { req, res } = makeReqRes();
        traceMiddleware(req, res, () => {
            expect(res.headers['X-Trace-Id']).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            );
            done();
        });
    });

    it('re-uses X-Trace-Id header from upstream when present', (done) => {
        const upstream = 'upstream-id-123';
        const { req, res } = makeReqRes({ 'x-trace-id': upstream });
        traceMiddleware(req, res, () => {
            expect(res.headers['X-Trace-Id']).toBe(upstream);
            done();
        });
    });

    it('re-uses X-Request-Id header when no X-Trace-Id is present', (done) => {
        const upstream = 'request-id-456';
        const { req, res } = makeReqRes({ 'x-request-id': upstream });
        traceMiddleware(req, res, () => {
            expect(res.headers['X-Trace-Id']).toBe(upstream);
            done();
        });
    });

    it('makes traceId available via getTraceId inside next()', (done) => {
        const { req, res } = makeReqRes();
        traceMiddleware(req, res, () => {
            const id = getTraceId();
            expect(id).toBe(res.headers['X-Trace-Id']);
            done();
        });
    });
});
