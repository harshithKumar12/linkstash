const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.LINKSTASH_DB_PATH || path.join(__dirname, '../data/links.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

function tableColumns(tableName) {
    return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
}

function migrate() {
    const version = db.pragma('user_version', { simple: true });
    if (version > 1) throw new Error(`Unsupported Linkstash database version: ${version}`);

    const migrateTransaction = db.transaction(() => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL UNIQUE,
                title TEXT,
                description TEXT,
                thumbnail TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_read BOOLEAN DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS link_tags (
                link_id INTEGER,
                tag_id INTEGER,
                PRIMARY KEY (link_id, tag_id),
                FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );
        `);

        const columns = tableColumns('links');
        if (!columns.has('metadata_status')) {
            db.exec("ALTER TABLE links ADD COLUMN metadata_status TEXT NOT NULL DEFAULT 'pending'");
        }
        if (!columns.has('metadata_attempts')) {
            db.exec('ALTER TABLE links ADD COLUMN metadata_attempts INTEGER NOT NULL DEFAULT 0');
        }
        if (!columns.has('metadata_error')) {
            db.exec('ALTER TABLE links ADD COLUMN metadata_error TEXT');
        }
        if (!columns.has('metadata_next_attempt_at')) {
            db.exec('ALTER TABLE links ADD COLUMN metadata_next_attempt_at DATETIME');
        }

        db.exec(`
            UPDATE links
            SET metadata_status = CASE
                WHEN title IS NOT NULL OR description IS NOT NULL THEN 'complete'
                ELSE 'pending'
            END
            WHERE metadata_status = 'pending' AND metadata_attempts = 0;

            CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_links_read_id ON links(is_read, id);
            CREATE INDEX IF NOT EXISTS idx_link_tags_tag_id ON link_tags(tag_id, link_id);

            DELETE FROM tags
            WHERE NOT EXISTS (
                SELECT 1 FROM link_tags WHERE link_tags.tag_id = tags.id
            );
        `);
        db.pragma('user_version = 1');
    });

    migrateTransaction();
}

migrate();

module.exports = db;
