import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import config from './app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = join(__dirname, '..', '..', config.database?.filename || 'data/zustmedia.sqlite');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'super_admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    title TEXT DEFAULT '',
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE
  )
`);

try { db.exec('ALTER TABLE tags ADD COLUMN slug TEXT'); } catch { /* already exists */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug)'); } catch { /* already exists */ }

{
  const rows = db.prepare('SELECT id, name FROM tags WHERE slug IS NULL').all();
  const stmt = db.prepare('UPDATE tags SET slug = ? WHERE id = ?');
  for (const row of rows) {
    let slug = row.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!slug) slug = `tag-${row.id}`;
    const existing = db.prepare('SELECT id FROM tags WHERE slug = ? AND id != ?').get(slug, row.id);
    if (existing) slug = `${slug}-${row.id}`;
    stmt.run(slug, row.id);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS image_tags (
    image_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (image_id, tag_id),
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  )
`);

try { db.exec('ALTER TABLE images ADD COLUMN exif TEXT DEFAULT \'{}\''); } catch { /* column already exists */ }

const hasUuidCol = db.prepare('PRAGMA table_info(images)').all().some(c => c.name === 'uuid');
if (!hasUuidCol) {
  db.exec('ALTER TABLE images ADD COLUMN uuid TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_images_uuid ON images(uuid)');

  const stmtBackfill = db.prepare('UPDATE images SET uuid = ? WHERE id = ?');
  const rowsToBackfill = db.prepare('SELECT id, filename FROM images').all();
  for (const row of rowsToBackfill) {
    const dotIdx = row.filename.lastIndexOf('.');
    const nameWithoutExt = dotIdx > 0 ? row.filename.substring(0, dotIdx) : row.filename;
    const uuid = nameWithoutExt.replace(/^img_/, '');
    stmtBackfill.run(uuid, row.id);
  }
}

try { db.exec('ALTER TABLE users ADD COLUMN uuid TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN slug TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN bio TEXT DEFAULT \'\''); } catch { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT \'\''); } catch { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_gallery_uuid TEXT DEFAULT NULL'); } catch { /* already exists */ }

// Migration: update role CHECK constraint to include 'super_admin'
{
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (tableInfo && !tableInfo.sql.includes("'super_admin'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'super_admin', 'user')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          uuid TEXT,
          slug TEXT,
          bio TEXT DEFAULT '',
          nickname TEXT DEFAULT '',
          default_gallery_uuid TEXT DEFAULT NULL
        )
      `);
      db.exec('INSERT INTO users_new SELECT * FROM users');
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch {
      try { db.exec('ROLLBACK'); } catch {}
      try { db.exec('DROP TABLE IF EXISTS users_new'); } catch {}
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec('ALTER TABLE images ADD COLUMN category_id INTEGER DEFAULT NULL REFERENCES categories(id) ON DELETE SET NULL'); } catch { /* already exists */ }

try { db.exec('ALTER TABLE images ADD COLUMN file_hash TEXT DEFAULT \'\''); } catch { /* already exists */ }
try { db.exec('ALTER TABLE images ADD COLUMN is_duplicate INTEGER DEFAULT 0'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE images ADD COLUMN duplicate_of INTEGER DEFAULT NULL'); } catch { /* already exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_images_file_hash ON images(file_hash)'); } catch { /* already exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_images_duplicate_of ON images(duplicate_of)'); } catch { /* already exists */ }

try { db.exec('ALTER TABLE images ADD COLUMN is_public INTEGER DEFAULT 0'); } catch { /* already exists */ }

{
  const hasDefaultCat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('uncategorized');
  if (!hasDefaultCat) {
    try { db.prepare('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)').run('无分类', 'uncategorized', '默认分类'); } catch { /* may already exist */ }
  }
}

{
  const hasUuidIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_uuid'").get();
  if (!hasUuidIdx) {
    db.exec('CREATE UNIQUE INDEX idx_users_uuid ON users(uuid)');
  }
}
{
  const hasSlugIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_slug'").get();
  if (!hasSlugIdx) {
    db.exec('CREATE UNIQUE INDEX idx_users_slug ON users(slug)');
  }
}

{
  const stmtBackfill = db.prepare('UPDATE users SET uuid = ? WHERE id = ? AND uuid IS NULL');
  const rows = db.prepare('SELECT id FROM users WHERE uuid IS NULL').all();
  for (const row of rows) {
    stmtBackfill.run(crypto.randomUUID(), row.id);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    uuid TEXT PRIMARY KEY,
    operator TEXT NOT NULL,
    action TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec('CREATE INDEX IF NOT EXISTS idx_logs_action ON activity_log(action)'); } catch { /* already exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_logs_created_at ON activity_log(created_at)'); } catch { /* already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS galleries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    creator_uuid TEXT NOT NULL,
    is_public INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_uuid) REFERENCES users(uuid) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS gallery_images (
    gallery_id INTEGER NOT NULL,
    image_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (gallery_id, image_id),
    FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
  )
`);

try { db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_images_image ON gallery_images(image_id)'); } catch { /* already exists */ }

try { db.exec('ALTER TABLE galleries ADD COLUMN is_archived INTEGER DEFAULT 0'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE galleries ADD COLUMN is_public_editable INTEGER DEFAULT 0'); } catch { /* already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS gallery_collaborators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id INTEGER NOT NULL,
    user_uuid TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('owner','admin','user')),
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(gallery_id, user_uuid),
    FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE,
    FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
  )
`);

try {
  const uncollaborated = db.prepare(`
    SELECT g.id, g.creator_uuid FROM galleries g
    WHERE NOT EXISTS (SELECT 1 FROM gallery_collaborators gc WHERE gc.gallery_id = g.id AND gc.role = 'owner')
  `).all();
  for (const g of uncollaborated) {
    db.prepare('INSERT OR IGNORE INTO gallery_collaborators (gallery_id, user_uuid, role) VALUES (?, ?, ?)').run(g.id, g.creator_uuid, 'owner');
  }
} catch { /* ignore */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS temp_auth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    max_uses INTEGER DEFAULT NULL,
    use_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(uuid) ON DELETE CASCADE
  )
`);

export default db;
