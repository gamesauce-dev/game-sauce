# Upgrade and restore test

Run this before a release that changes the database, backups or the way the server starts. It uses a throwaway
library, so your real one is never at risk. It takes about half an hour.

## Set up
1. Make a test folder (for example `C:\gs-test`). Download an **older** portable release (the `windows-x64.zip`
   or `linux-x64.tar.gz`) from the releases page and unpack it to `gs-test/old`.
2. Start it with its own data folder, using the `--data` option (open a command prompt, not Explorer, so the
   option is passed):
   ```
   cd C:\gs-test\old
   "Start game-sauce.bat" --data C:\gs-test\home
   ```
   (Linux/macOS: `./start.sh --data ~/gs-test/home`.) Use this exact `--data` value every time you start a version
   in this test. `--data` is the parent folder: game-sauce creates `data` and `storage` inside it, so the database
   is `C:\gs-test\home\data\gamesauce.db`. Check that file exists before going on; if it does not, the test is
   running against your real library in `game-sauce-data` in your home folder, so stop and fix that first.
   (`set GAMESAUCE_HOME=...` also works, but only for the command prompt window it was typed in, and not for a
   double-clicked start script.)
   The first-run account is printed once: write it down and sign in.
3. Give it a small life: add one source with a few ROMs and scan it; mark a favourite; make a collection with a
   game in it; create a second user and send a message between the two; pick a language other than English; play a
   game in the browser and make a save state.
4. Write down what to compare later: game count, the favourite, the collection, the message, the language, and the
   version at the bottom of **Settings, My account**.

## Take the backups
5. **Settings, Backups, Download a backup now.** Keep the file.
6. Stop game-sauce, then copy the whole `gs-test/home` folder to `gs-test/home-before`.

## Test 1: upgrade
7. Stop the old version. Unpack the **new** portable release to `gs-test/new` and start it with the **same**
   `--data C:\gs-test\home`.
8. Check: it starts without errors and you can sign in; the game count, favourite, collection, message and
   language are as before; the save state loads; the version at the bottom of My account is the new one;
   **Settings, System health** shows nothing red.

## Test 2: restore
9. On the new version, change things: delete the collection, remove the favourite, add a game.
10. **Settings, Backups, Restore from a backup.** Upload the backup from step 5 and press **Check this backup**.
11. Read what it shows next to what is on the server now. Nothing has changed yet.
12. Type `RESTORE` and confirm. It restarts.
13. Check: you have to sign in again; everything is back as in step 4 (collection, favourite, message, save state);
    a `pre-restore-<time>` folder exists in `gs-test/home/data`; a safety backup of the "changed" state is in the
    backups folder.

## Test 3 (optional): a newer backup on an older app
The refusal only happens when the backup's database version is **higher** than the older app's. Many releases share
one number (0.6.1 up to the current release are all 57), so an "old" release from that range will happily accept
the backup and the test proves nothing. Use a release with a lower number: **0.6.0 or earlier** (0.6.0 is 56,
0.5.1 is 55; 0.5.0 is 47).
14. On the new version, download a fresh backup. Unpack the older release (0.6.0 or earlier) to `gs-test/oldest`
    and start it on a **new, empty** data folder: `--data C:\gs-test\home-oldest`.
15. Sign in and check **Settings, My account** shows a database version **lower** than the backup's (the new
    version shows it at the same place). If the numbers are equal, pick an earlier release.
16. Try to restore the backup on the old app. It must be **refused**, with a message that the backup is from a
    newer game-sauce (database version N; this server understands up to M). Nothing changes.

## Before updating a live server
17. Take a snapshot first (on Proxmox: `pct snapshot <id> before-<version>`, or a vzdump), then run the update.
    If anything looks wrong, roll back to the snapshot.

## Good to know
- A backup holds the database, the encryption key and the save states. **Imported ROMs, covers and media are not
  in it** (see [DEPLOYMENT.md](DEPLOYMENT.md#5-backup)).
- If something fails, note the step number, what you saw, and the server's output or the **Copy report** text from
  System health, and open an issue.

Record of runs (add a line each time): date, from version, to version, result.
- 2026-11-28: Docker on Unraid, 0.11.1 to the `latest` image of that day (`main`, df1918b): upgrade passed, and restoring the 0.11.1 backup brought the data back. The container did not start again by itself after the restore and had to be started by hand (the template had no restart setting). With `--restart=on-failure` added to the container's Extra Parameters, a second restore restarted by itself.
- 2026-11-16: 0.6.3, 0.9.0 and 0.11.0 to 0.11.1: upgrade and restore passed (all database version 57, so no migration was exercised). 0.6.0 (database version 56) refused the version 57 backup, as it should.
