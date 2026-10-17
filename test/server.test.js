const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { once } = require('node:events');
const { request } = require('node:http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkstash-test-'));
process.env.LINKSTASH_DB_PATH = path.join(tempDir, 'links.db');

const database = require('../src/db');
const { createApp, normalizeTags, normalizeUrl } = require('../src/server');
const { assertSafeUrl, isPrivateAddress } = require('../src/metadata');

function httpRequest(server, method, requestPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request({
            host: '127.0.0.1',
            port: server.address().port,
            path: requestPath,
            method,
            agent: false,
            headers: payload ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            } : {}
        }, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode,
                body: responseBody ? JSON.parse(responseBody) : null,
                headers: res.headers
            }));
        });
        req.on('error', reject);
        if (payload) req.end(payload); else req.end();
    });
}

function rawHttpRequest(server, method, requestPath, payload) {
    return new Promise((resolve, reject) => {
        const req = request({
            host: '127.0.0.1',
            port: server.address().port,
            path: requestPath,
            method,
            agent: false,
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode,
                body: responseBody ? JSON.parse(responseBody) : null,
                headers: res.headers
            }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

const app = createApp({
    database,
    metadataFetcher: async () => ({ title: '<title>', description: '<description>', thumbnail: '' })
});
const server = app.listen(0, '127.0.0.1');

test('normalizes and validates user input', () => {
    assert.equal(normalizeUrl('https://example.com/read-later'), 'https://example.com/read-later');
    assert.throws(() => normalizeUrl('file:///etc/passwd'), /valid HTTP or HTTPS/);
    assert.throws(() => normalizeUrl('not a URL'), /valid HTTP or HTTPS/);
    assert.deepEqual(normalizeTags([' JS ', 'js', '<script>', '', 4]), ['js', '<script>']);
});

test('blocks private metadata addresses without blocking public IPv6', async () => {
    assert.equal(isPrivateAddress('127.0.0.1'), true);
    assert.equal(isPrivateAddress('::1'), true);
    assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
    await assert.rejects(assertSafeUrl('http://127.0.0.1:3000'), /Private metadata hosts/);
    await assert.rejects(assertSafeUrl('http://[::1]:3000'), /Private metadata hosts/);
    const safe = await assertSafeUrl('https://[2001:4860:4860::8888]/');
    assert.equal(safe.hostname, '[2001:4860:4860::8888]');
});

test('serves health and creates a link without waiting for metadata', async () => {
    const health = await httpRequest(server, 'GET', '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok' });

    const created = await httpRequest(server, 'POST', '/api/links', {
        url: 'https://example.com/article',
        tags: ['Reading', 'reading']
    });
    assert.equal(created.status, 201);

    await new Promise((resolve) => setImmediate(resolve));
    const links = await httpRequest(server, 'GET', '/api/links?tag=reading');
    assert.equal(links.status, 200);
    assert.equal(links.body.length, 1);
    assert.equal(links.body[0].title, '<title>');
    assert.equal(links.body[0].tags, 'reading');

    const deleted = await httpRequest(server, 'DELETE', `/api/links/${links.body[0].id}`);
    assert.equal(deleted.status, 204);
    const tags = await httpRequest(server, 'GET', '/api/tags');
    assert.deepEqual(tags.body, []);
});

test('rejects invalid URLs and reports missing resources', async () => {
    const malformed = await rawHttpRequest(server, 'POST', '/api/links', '{"url":');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'Request body must be valid JSON');

    const invalid = await httpRequest(server, 'POST', '/api/links', { url: 'ftp://example.com' });
    assert.equal(invalid.status, 400);

    const missingPatch = await httpRequest(server, 'PATCH', '/api/links/9999', { is_read: true });
    assert.equal(missingPatch.status, 404);

    const missingDelete = await httpRequest(server, 'DELETE', '/api/links/9999');
    assert.equal(missingDelete.status, 404);
});

test('paginates the queue and supports read status and random unread selection', async () => {
    for (const suffix of ['one', 'two', 'three']) {
        const created = await httpRequest(server, 'POST', '/api/links', {
            url: `https://example.com/${suffix}`,
            tags: ['pagination']
        });
        assert.equal(created.status, 201);
    }

    const firstPage = await httpRequest(server, 'GET', '/api/links?tag=pagination&limit=2&offset=0');
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.length, 2);
    assert.equal(firstPage.body.every((link) => link.tags === 'pagination'), true);
    assert.equal(firstPage.headers['x-has-more'], 'true');

    const secondPage = await httpRequest(server, 'GET', '/api/links?tag=pagination&limit=2&offset=2');
    assert.equal(secondPage.status, 200);
    assert.ok(secondPage.body.length >= 1);

    const unreadBefore = await httpRequest(server, 'GET', '/api/links/random');
    assert.equal(unreadBefore.status, 200);
    const marked = await httpRequest(server, 'PATCH', `/api/links/${unreadBefore.body.id}`, { is_read: true });
    assert.equal(marked.status, 200);
    const unreadAfter = await httpRequest(server, 'GET', '/api/links/random');
    assert.equal(unreadAfter.status, 200);
    assert.notEqual(unreadAfter.body.id, unreadBefore.body.id);
});

test('keeps the link when metadata fails synchronously', async () => {
    const resilientApp = createApp({
        database,
        metadataFetcher: () => { throw new Error('metadata unavailable'); }
    });
    const resilientServer = resilientApp.listen(0, '127.0.0.1');
    await once(resilientServer, 'listening');

    try {
        const created = await new Promise((resolve, reject) => {
            const payload = JSON.stringify({ url: 'https://example.com/sync-metadata-failure' });
            const req = request({
                host: '127.0.0.1',
                port: resilientServer.address().port,
                path: '/api/links',
                method: 'POST',
                agent: false,
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload)
                }
            }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
            });
            req.on('error', reject);
            req.end(payload);
        });
        assert.equal(created.status, 201);
        assert.ok(created.body.id);
    } finally {
        await resilientApp.locals.stopBackgroundJobs();
        resilientServer.close();
        await once(resilientServer, 'close');
    }
});

after(async () => {
    await app.locals.stopBackgroundJobs();
    server.close();
    await once(server, 'close');
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});
