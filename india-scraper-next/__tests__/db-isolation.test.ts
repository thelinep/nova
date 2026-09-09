/** @jest-environment node */
import db from '../lib/db';
it('keeps test cleanup away from persisted operator databases', async () => {
  const databases = await new Promise<Array<{name:string;file:string}>>((resolve,reject)=>db.all('PRAGMA database_list',(error,rows)=>error?reject(error):resolve(rows as Array<{name:string;file:string}>)));
  expect(databases.find(database=>database.name==='main')?.file).toBe('');
});
afterAll(async()=>new Promise<void>((resolve,reject)=>db.close(error=>error?reject(error):resolve())));
