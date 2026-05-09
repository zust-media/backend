import Database from 'better-sqlite3';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const yamlPath = join(__dirname, '..', 'config.yaml');
let config;
try {
  config = load(readFileSync(yamlPath, 'utf8'));
} catch {
  console.error('config.yaml 未找到，无法执行迁移');
  process.exit(1);
}

const dbPath = join(__dirname, '..', config.database?.filename || 'data/zustmedia.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('开始数据库迁移...');

// --- tags: 新增 slug 列 ---
try { db.exec('ALTER TABLE tags ADD COLUMN slug TEXT'); } catch { /* already exists */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug)'); } catch { /* already exists */ }

// --- tags: slug 数据回填 ---
{
  const rows = db.prepare('SELECT id, name FROM tags WHERE slug IS NULL').all();
  if (rows.length > 0) {
    const stmt = db.prepare('UPDATE tags SET slug = ? WHERE id = ?');
    for (const row of rows) {
      let slug = row.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!slug) slug = `tag-${row.id}`;
      const existing = db.prepare('SELECT id FROM tags WHERE slug = ? AND id != ?').get(slug, row.id);
      if (existing) slug = `${slug}-${row.id}`;
      stmt.run(slug, row.id);
    }
    console.log(`tags slug 回填完成: ${rows.length} 条`);
  }
}

// --- images: 新增 exif 列 ---
try { db.exec("ALTER TABLE images ADD COLUMN exif TEXT DEFAULT '{}'"); } catch { /* already exists */ }

// --- images: 新增 uuid 列并回填 ---
{
  const hasUuidCol = db.prepare('PRAGMA table_info(images)').all().some(c => c.name === 'uuid');
  if (!hasUuidCol) {
    db.exec('ALTER TABLE images ADD COLUMN uuid TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_images_uuid ON images(uuid)');
    const stmt = db.prepare('UPDATE images SET uuid = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, filename FROM images').all();
    for (const row of rows) {
      const dotIdx = row.filename.lastIndexOf('.');
      const nameWithoutExt = dotIdx > 0 ? row.filename.substring(0, dotIdx) : row.filename;
      const uuid = nameWithoutExt.replace(/^img_/, '');
      stmt.run(uuid, row.id);
    }
    console.log(`images uuid 回填完成: ${rows.length} 条`);
  }
}

// --- images: 新增 category_id 外键列 ---
try { db.exec('ALTER TABLE images ADD COLUMN category_id INTEGER DEFAULT NULL REFERENCES categories(id) ON DELETE SET NULL'); } catch { /* already exists */ }

// --- images: 新增去重相关列和索引 ---
try { db.exec("ALTER TABLE images ADD COLUMN file_hash TEXT DEFAULT ''"); } catch { /* already exists */ }
try { db.exec('ALTER TABLE images ADD COLUMN is_duplicate INTEGER DEFAULT 0'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE images ADD COLUMN duplicate_of INTEGER DEFAULT NULL'); } catch { /* already exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_images_file_hash ON images(file_hash)'); } catch { /* already exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_images_duplicate_of ON images(duplicate_of)'); } catch { /* already exists */ }

// --- images: 新增 is_public 列 ---
try { db.exec('ALTER TABLE images ADD COLUMN is_public INTEGER DEFAULT 0'); } catch { /* already exists */ }

// --- users: 新增列 ---
try { db.exec('ALTER TABLE users ADD COLUMN uuid TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN slug TEXT'); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT ''"); } catch { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_gallery_uuid TEXT DEFAULT NULL'); } catch { /* already exists */ }

// --- users: role CHECK 约束增加 super_admin ---
{
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (tableInfo && !tableInfo.sql.includes("'super_admin'")) {
    console.log('升级 users 表 role CHECK 约束，增加 super_admin...');
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
      console.log('users 表 role CHECK 约束升级完成');
    } catch (err) {
      console.error('users 表迁移失败，正在回滚:', err.message);
      try { db.exec('ROLLBACK'); } catch {}
      try { db.exec('DROP TABLE IF EXISTS users_new'); } catch {}
      process.exit(1);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

// --- categories: 默认分类 ---
{
  const hasDefaultCat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('uncategorized');
  if (!hasDefaultCat) {
    try { db.prepare('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)').run('无分类', 'uncategorized', '默认分类'); } catch { /* may already exist */ }
    console.log('默认分类已创建');
  }
}

// --- users: 索引创建 ---
{
  const hasUuidIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_uuid'").get();
  if (!hasUuidIdx) {
    db.exec('CREATE UNIQUE INDEX idx_users_uuid ON users(uuid)');
  }
  const hasSlugIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_slug'").get();
  if (!hasSlugIdx) {
    db.exec('CREATE UNIQUE INDEX idx_users_slug ON users(slug)');
  }
}

// --- users: uuid 数据回填 ---
{
  const stmt = db.prepare('UPDATE users SET uuid = ? WHERE id = ? AND uuid IS NULL');
  const rows = db.prepare('SELECT id FROM users WHERE uuid IS NULL').all();
  if (rows.length > 0) {
    for (const row of rows) {
      stmt.run(crypto.randomUUID(), row.id);
    }
    console.log(`users uuid 回填完成: ${rows.length} 条`);
  }
}

// --- activity_log: 索引 ---
try { db.exec('CREATE INDEX IF NOT EXISTS idx_logs_action ON activity_log(action)'); } catch { /* already exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_logs_created_at ON activity_log(created_at)'); } catch { /* already exists */ }

// --- gallery_images: 索引 ---
try { db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_images_image ON gallery_images(image_id)'); } catch { /* already exists */ }

// --- galleries: 新增列 ---
try { db.exec('ALTER TABLE galleries ADD COLUMN is_archived INTEGER DEFAULT 0'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE galleries ADD COLUMN is_public_editable INTEGER DEFAULT 0'); } catch { /* already exists */ }

// --- gallery_collaborators: 协作者数据回填 ---
try {
  const uncollaborated = db.prepare(`
    SELECT g.id, g.creator_uuid FROM galleries g
    WHERE NOT EXISTS (SELECT 1 FROM gallery_collaborators gc WHERE gc.gallery_id = g.id AND gc.role = 'owner')
  `).all();
  if (uncollaborated.length > 0) {
    const stmt = db.prepare('INSERT OR IGNORE INTO gallery_collaborators (gallery_id, user_uuid, role) VALUES (?, ?, ?)');
    for (const g of uncollaborated) {
      stmt.run(g.id, g.creator_uuid, 'owner');
    }
    console.log(`gallery_collaborators owner 回填完成: ${uncollaborated.length} 条`);
  }
} catch { /* ignore */ }

console.log('数据库迁移完成！');
