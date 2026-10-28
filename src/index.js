import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createServer } from './server.js';

// PORT=0 picks a free port (the restart test uses it); the real port is printed below.
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
// Local only by default. HOST=0.0.0.0 opens the tracker to the local network.
const host = process.env.HOST || '127.0.0.1';
const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);
const dataFile = process.env.DATA_FILE || fileURLToPath(new URL('../data/db.json', import.meta.url));

const server = createServer(new Store(dataFile), { localOnly });
server.listen(port, host, () => {
  console.log(`Work time tracker: http://${localOnly ? 'localhost' : host}:${server.address().port}`);
  console.log(`Data: ${dataFile}`);
});
