import './lib/restore-boot.js'; // MUST stay first: applies a staged restore before the database opens
import { prepareApp } from './app.js';
import { startBackupScheduler } from './lib/backup.js';
import { startUpdateNotifier } from './lib/updatenotify.js';
import { startSnapshotTimer } from './lib/reports.js';
import { startHashScheduler } from './lib/hashjob.js';
import { fetchLatestRelease } from './routes/emulators.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const { app } = await prepareApp();

app.listen(PORT, HOST, () => {
  console.log(`game-sauce listening on http://${HOST}:${PORT}`);
  startBackupScheduler(); // runs only when a schedule is set under Settings → Backups
  startHashScheduler(); // fingerprints for games a scan added, in the background (or in the admin's overnight window)
  startSnapshotTimer(); // one row of headline counts a day, for the Reports trends
  startUpdateNotifier(fetchLatestRelease); // tells the admins in Messages when a newer game-sauce is out (off with GAMESAUCE_UPDATE_CHECK=0)
});
