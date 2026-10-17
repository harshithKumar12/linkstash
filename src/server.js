require('dotenv').config();

const express = require('express');
const path = require('path');
const db = require('./db');
const { fetchMetadata } = require('./metadata');

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_PAGE_SIZE = 100;
const MAX_METADATA_ATTEMPTS = 3;
const METADATA_WORKERS = 2;

function pageValue(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags
        .filter((tag) => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .map((tag) => tag.slice(0, MAX_TAG_LENGTH)))]
        .slice(0, MAX_TAGS);
}

function normalizeUrl(value) {
    if (typeof value !== 'string') {
        throw new Error('A valid HTTP or HTTPS URL is required');
    }
    const trimmed = value.trim();
    if (trimmed.length > 2048) {
        throw new Error('A valid HTTP or HTTPS URL is required');
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (error) {
        throw new Error('A valid HTTP or HTTPS URL is required');
    }

    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 2048) {
        throw new Error('A valid HTTP or HTTPS URL is required');
    }
    return parsed.href;
}

// Helper to handle tags
function associateTags(database, linkId, tags) {
    const normalizedTags = normalizeTags(tags);
    if (!normalizedTags.length) return;

    const stmtTags = database.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
    const stmtGetTag = database.prepare('SELECT id FROM tags WHERE name = ?');
    const stmtLinkTags = database.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag_id) VALUES (?, ?)');

    for (const tagName of normalizedTags) {
        stmtTags.run(tagName);
        const tag = stmtGetTag.get(tagName);
        stmtLinkTags.run(linkId, tag.id);
    }
}

function createApp({ database = db, metadataFetcher = fetchMetadata } = {}) {
    const app = express();
    const metadataTimers = new Map();
    let activeMetadataJobs = 0;
    let stopping = false;

    function stopBackgroundJobs() {
        stopping = true;
        for (const timer of metadataTimers.values()) clearTimeout(timer);
        metadataTimers.clear();
        if (activeMetadataJobs === 0) return Promise.resolve();
        return new Promise((resolve) => {
            const deadline = Date.now() + 5_000;
            const waitForWorkers = () => {
                if (activeMetadataJobs === 0 || Date.now() >= deadline) return resolve();
                const timer = setTimeout(waitForWorkers, 50);
                timer.unref?.();
            };
            waitForWorkers();
        });
    }

    function updateMetadataFailure(linkId, attempt, error, retryAt = null) {
        database.prepare(`
            UPDATE links
            SET metadata_status = ?, metadata_attempts = ?, metadata_error = ?, metadata_next_attempt_at = ?
            WHERE id = ?
        `).run(retryAt ? 'pending' : 'failed', attempt, String(error.message || error).slice(0, 500), retryAt, linkId);
    }

    async function runMetadataJob(linkId, url) {
        if (stopping) return false;
        if (activeMetadataJobs >= METADATA_WORKERS) {
            enqueueMetadata(linkId, url, 100);
            return false;
        }
        activeMetadataJobs += 1;
        try {
            const current = database.prepare('SELECT metadata_attempts FROM links WHERE id = ?').get(linkId);
            if (!current) return true;
            const attempt = current.metadata_attempts + 1;
            database.prepare(`
                UPDATE links
                SET metadata_status = 'processing', metadata_attempts = ?, metadata_error = NULL,
                    metadata_next_attempt_at = NULL
                WHERE id = ?
            `).run(attempt, linkId);

            try {
                const metadata = await metadataFetcher(url);
                if (metadata.metadataStatus === 'failed') {
                    throw new Error(metadata.metadataError || 'Metadata fetch failed');
                }
                database.prepare(`
                    UPDATE links
                    SET title = ?, description = ?, thumbnail = ?, metadata_status = 'complete',
                        metadata_error = NULL, metadata_next_attempt_at = NULL
                    WHERE id = ?
                `).run(metadata.title, metadata.description, metadata.thumbnail, linkId);
            } catch (error) {
                if (attempt < MAX_METADATA_ATTEMPTS && !stopping) {
                    const delay = 2 ** attempt * 1000;
                    const retryAt = new Date(Date.now() + delay).toISOString();
                    updateMetadataFailure(linkId, attempt, error, retryAt);
                    enqueueMetadata(linkId, url, delay);
                } else {
                    updateMetadataFailure(linkId, attempt, error);
                }
            }
            return true;
        } finally {
            activeMetadataJobs -= 1;
        }
    }

    function enqueueMetadata(linkId, url, delay = 0) {
        if (stopping || metadataTimers.has(linkId)) return;
        const timer = setTimeout(() => {
            metadataTimers.delete(linkId);
            void runMetadataJob(linkId, url).catch((error) => {
                console.error(`Metadata worker failed for link ${linkId}:`, error.message);
            });
        }, delay);
        timer.unref?.();
        metadataTimers.set(linkId, timer);
    }

    app.locals.stopBackgroundJobs = stopBackgroundJobs;

    app.disable('x-powered-by');
    app.use(express.json({ limit: '16kb' }));
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
        next();
    });
    app.use(express.static(path.join(__dirname, '../public')));

    app.get('/healthz', (req, res) => {
        try {
            database.prepare('SELECT 1').get();
            res.json({ status: 'ok' });
        } catch (error) {
            res.status(503).json({ status: 'unavailable' });
        }
    });

    // POST /api/links - Add a new link
    app.post('/api/links', async (req, res) => {
        let url;
        try {
            url = normalizeUrl(req.body?.url);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        try {
            const createLink = database.transaction(() => {
                const existing = database.prepare('SELECT id FROM links WHERE url = ?').get(url);
                if (existing) return { duplicate: true };

                const info = database.prepare('INSERT INTO links (url) VALUES (?)').run(url);
                associateTags(database, info.lastInsertRowid, req.body?.tags);
                return { linkId: info.lastInsertRowid };
            });
            const created = createLink();
            if (created.duplicate) {
                return res.status(409).json({ error: 'URL already exists in your stash' });
            }
            const linkId = created.linkId;

            // Metadata is queued so links remain usable immediately and pending
            // jobs can be retried or resumed after a process restart.
            enqueueMetadata(linkId, url);

            return res.status(201).json({ message: 'Link added successfully', id: linkId });
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                return res.status(409).json({ error: 'URL already exists in your stash' });
            }
            console.error(error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // GET /api/links - Get the queue
    app.get('/api/links', (req, res) => {
        const tag = typeof req.query.tag === 'string' ? req.query.tag.trim().toLowerCase() : '';
        const sort = req.query.sort;
        const limit = Math.min(pageValue(req.query.limit, MAX_PAGE_SIZE), MAX_PAGE_SIZE);
        const offset = pageValue(req.query.offset, 0);
        const whereClause = tag
            ? ' WHERE EXISTS (SELECT 1 FROM link_tags filter_lt JOIN tags filter_t ON filter_t.id = filter_lt.tag_id WHERE filter_lt.link_id = l.id AND filter_t.name = ?)'
            : '';

        try {
            const total = database.prepare(`SELECT COUNT(*) AS count FROM links l${whereClause}`).get(...(tag ? [tag] : [])).count;
            const query = `
                SELECT l.*,
                    (
                        SELECT GROUP_CONCAT(ordered_tags.name, ',')
                        FROM (
                            SELECT t.name
                            FROM link_tags lt
                            JOIN tags t ON t.id = lt.tag_id
                            WHERE lt.link_id = l.id
                            ORDER BY t.name COLLATE NOCASE
                        ) AS ordered_tags
                    ) AS tags,
                    (SELECT MIN(t.name) FROM link_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.link_id = l.id) AS tag_sort
                FROM links l
                ${whereClause}
                ${sort === 'tag' ? 'ORDER BY tag_sort IS NULL, tag_sort COLLATE NOCASE ASC, l.id DESC' : 'ORDER BY l.created_at DESC, l.id DESC'}
                LIMIT ? OFFSET ?
            `;
            const links = database.prepare(query).all(...(tag ? [tag, limit, offset] : [limit, offset]));
            res.setHeader('X-Total-Count', String(total));
            res.setHeader('X-Has-More', String(offset + links.length < total));
            return res.json(links);
        } catch (error) {
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // PATCH /api/links/:id - Toggle read status
    app.patch('/api/links/:id', (req, res) => {
        const { is_read } = req.body || {};
        const { id } = req.params;

        if (typeof is_read !== 'boolean') return res.status(400).json({ error: 'is_read must be a boolean' });

        try {
            const result = database.prepare('UPDATE links SET is_read = ? WHERE id = ?').run(is_read ? 1 : 0, id);
            if (!result.changes) return res.status(404).json({ error: 'Link not found' });
            return res.json({ message: 'Status updated' });
        } catch (error) {
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // GET /api/links/random - Surprise Me
    app.get('/api/links/random', (req, res) => {
        try {
            const unreadCount = database.prepare('SELECT COUNT(*) AS count FROM links WHERE is_read = 0').get().count;
            if (!unreadCount) return res.status(404).json({ error: 'No unread links found!' });
            const offset = Math.floor(Math.random() * unreadCount);
            const link = database.prepare('SELECT * FROM links WHERE is_read = 0 ORDER BY id LIMIT 1 OFFSET ?').get(offset);
            if (!link) return res.status(404).json({ error: 'No unread links found!' });
            return res.json(link);
        } catch (error) {
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // GET /api/tags - List all tags
    app.get('/api/tags', (req, res) => {
        try {
            const tags = database.prepare(`
                SELECT DISTINCT t.name
                FROM tags t
                INNER JOIN link_tags lt ON lt.tag_id = t.id
                ORDER BY t.name ASC
            `).all();
            return res.json(tags.map((t) => t.name));
        } catch (error) {
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // DELETE /api/links/:id - Remove link
    app.delete('/api/links/:id', (req, res) => {
        const { id } = req.params;
        try {
            const deleteLink = database.transaction(() => {
                const result = database.prepare('DELETE FROM links WHERE id = ?').run(id);
                if (result.changes) {
                    database.prepare(`
                        DELETE FROM tags
                        WHERE NOT EXISTS (
                            SELECT 1 FROM link_tags WHERE link_tags.tag_id = tags.id
                        )
                    `).run();
                }
                return result;
            });
            const result = deleteLink();
            if (!result.changes) return res.status(404).json({ error: 'Link not found' });
            return res.status(204).end();
        } catch (error) {
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.use((error, req, res, next) => {
        if (error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed') {
            return res.status(400).json({ error: 'Request body must be valid JSON' });
        }
        if (error.type === 'entity.too.large') {
            return res.status(413).json({ error: 'Request body is too large' });
        }
        if (res.headersSent) return next(error);
        console.error(error);
        return res.status(500).json({ error: 'Internal server error' });
    });

    database.prepare(`
        SELECT id, url
        FROM links
        WHERE metadata_status IN ('pending', 'processing')
           OR (metadata_status = 'failed' AND metadata_attempts < ? AND metadata_next_attempt_at <= CURRENT_TIMESTAMP)
    `).all(MAX_METADATA_ATTEMPTS).forEach((link) => enqueueMetadata(link.id, link.url));

    return app;
}

function startServer({ port = process.env.PORT || 3000, host = process.env.HOST || '127.0.0.1', ...options } = {}) {
    const app = createApp(options);
    const database = options.database || db;
    const server = app.listen(port, host, () => {
        console.log(`Linkstash server running at http://${host}:${server.address().port}`);
    });
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        void app.locals.stopBackgroundJobs().then(() => {
            server.close(() => {
                database.close();
                if (signal) process.exit(0);
            });
        });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    server.shutdown = shutdown;
    return server;
}

if (require.main === module) startServer();

module.exports = { createApp, normalizeTags, normalizeUrl, startServer };
