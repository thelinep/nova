import sqlite3 from 'sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB error:', err.message);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS districts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      state TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scraped_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      district_id INTEGER,
      business_name TEXT,
      contact_person TEXT,
      phone TEXT,
      address TEXT,
      website TEXT,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (district_id) REFERENCES districts(id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scraped_category ON scraped_data(category)`);
  // Gracefully add columns if they don't exist yet (SQLite lacks IF NOT EXISTS for ADD COLUMN).
  const addColumn = (table: string, column: string, type: string) => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (err) => {
      if (err && !err.message.includes('duplicate column')) console.error(`ALTER ${table} ADD ${column} failed:`, err.message);
    });
  };
  addColumn('scraped_data', 'rating', 'TEXT');
  addColumn('scraped_data', 'reviews', 'TEXT');
  addColumn('scraped_data', 'maps_url', 'TEXT');
  addColumn('scraped_data', 'latitude', 'REAL');
  addColumn('scraped_data', 'longitude', 'REAL');

  db.run(`
    CREATE TABLE IF NOT EXISTS refined_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      district_id INTEGER,
      business_name TEXT,
      contact_person TEXT,
      phone TEXT,
      address TEXT,
      website TEXT,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category, district_id, business_name, phone) ON CONFLICT REPLACE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_refined_category ON refined_data(category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_refined_district ON refined_data(district_id)`);
  addColumn('refined_data', 'rating', 'TEXT');
  addColumn('refined_data', 'reviews', 'TEXT');
  addColumn('refined_data', 'maps_url', 'TEXT');
  addColumn('refined_data', 'latitude', 'REAL');
  addColumn('refined_data', 'longitude', 'REAL');
});

export default db;
