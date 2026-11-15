# Upgrade and restore test

Run this before a release that changes the database, backups or the way the server starts. It uses a throwaway
library, so your real one is never at risk. It takes about half an hour.

## Set up
1. Make a test folder (for example `C:\gs-test`). Download an **older** portable release (the `windows-x64.zip`
   or `linux-x64.tar.gz`) from the releases page and unpack it to `gs-test/old`.
2. Start it with its own data folder: set `GAMESAUCE_HOME` to `gs-test/data` first, then run the start script.
   The first-run account is printed once: write it down and sign in.
3. Give it a small life: add one source with a few ROMs and scan it; mark a favourite; make a collection with a
   game in it; create a second user and send a message between the two; pick a language other than English; play a
   game in the browser and make a save state.
4. Write down what to compare later: game count, the favourite, the collection, the message, the language, and the
   version at the bottom of **Settings, My account**.

## Take the backups
5. **Settings, Backups, Download a backup now.** Keep the file.
6. Copy the whole data folder (`gs-test/data`) to `gs-test/data-before`.

## Test 1: upgrade
7. Stop the old version. Unpack the **new** portable release to `gs-test/new` and start it with the **same**
   `GAMESAUCE_HOME`.
8. Check: it starts without errors and you can sign in; the game count, favourite, collection, message and
   language are as before; the save state loads; the version at the bottom of My account is the new one;
   **Settings, System health** shows nothing red.

## Test 2: restore
9. On the new version, change things: delete the collection, remove the favourite, add a game.
10. **Settings, Backups, Restore from a backup.** Upload the backup from step 5 and press **Check this backup**.
11. Read what it shows next to what is on the server now. Nothing has changed yet.
12. Type `RESTORE` and confirm. It restarts.
13. Check: you have to sign in again; everything is back as in step 4 (collection, favourite, message, save state);
    a `pre-restore-<time>` folder exists in the data folder; a safety backup of the "changed" state is in the
    backups folder.

## Test 3 (optional): a newer backup on an older app
14. On the new version, download a fresh backup. Start the **old** version on a copy of the data and try to restore
    that backup. It must be **refused**, with a message that the backup is from a newer version.

## Before updating a live server
15. Take a snapshot first (on Proxmox: `pct snapshot <id> before-<version>`, or a vzdump), then run the update.
    If anything looks wrong, roll back to the snapshot.

## Good to know
- A backup holds the database, the encryption key and the save states. **Imported ROMs, covers and media are not
  in it** (see [DEPLOYMENT.md](DEPLOYMENT.md#5-backup)).
- If something fails, note the step number, what you saw, and the server's output or the **Copy report** text from
  System health, and open an issue.

Record of runs (add a line each time): date, from version, to version, result.
