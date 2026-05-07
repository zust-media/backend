import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = join(__dirname, '..', '..', 'data', 'zustmedia.sqlite');
const isNew = !existsSync(dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
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

if (isNew) {
  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (username, password, role, uuid) VALUES (?, ?, ?, ?)'
  );
  insertUser.run('admin', bcrypt.hashSync('admin123', 10), 'admin', crypto.randomUUID());
  insertUser.run('user', bcrypt.hashSync('user123', 10), 'user', crypto.randomUUID());
}

export default db;
