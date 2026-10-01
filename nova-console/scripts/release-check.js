'use strict';

const path = require('node:path');
const { openDb, Store } = require('../lib/db');
const releaseGates = require('../lib/release-gates');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const { db } = openDb(dataDir);
try {
  const result = releaseGates.check(new Store(db));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.releaseReady) process.exitCode = 1;
} finally {
  db.close();
}
