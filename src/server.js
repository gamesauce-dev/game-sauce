import './lib/restore-boot.js'; // MUST stay first: applies a staged restore before the database opens
import { prepareApp } from './app.js';
import { startBackupScheduler } from './lib/backup.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const { app } = await prepareApp();

app.listen(PORT, HOST, () => {
  console.log(`game-sauce listening on http://${HOST}:${PORT}`);
  startBackupScheduler(); // runs only when a schedule is set under Settings → Backups
});
