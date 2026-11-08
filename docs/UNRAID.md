# game-sauce on Unraid

Unraid runs game-sauce from the ready-made image (`ghcr.io/gamesauce-dev/game-sauce`), so there is nothing to build.
A template fills in the ports, folders and settings; you only choose where your ROMs are.

## Install

1. Open the Unraid web page, then **Terminal** (the `>_` icon at the top right) and paste this one line:

   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/game-sauce.xml https://raw.githubusercontent.com/gamesauce-dev/game-sauce/main/install/unraid/game-sauce.xml
   ```

2. Go to the **Docker** tab, click **Add Container**, and choose **game-sauce** from the **Template** list (under *User templates*).
3. Check the settings, then click **Apply**:
   - **Web UI port**: `8765` unless something else uses it.
   - **ROM folder (read-only)**: the Unraid share that holds your ROMs (for example `/mnt/user/roms`). Leave it as it is if you have none yet; you can add it later.
   - **Admin password**: set one (10+ characters, with a letter and a number), or leave it blank and one is made for you.
4. Click the container's icon and choose **WebUI**. If you left the password blank, click **Logs** instead and copy the account shown there. It is shown only once.
5. In game-sauce, go to **Settings → Sources** and add `/roms` (or a folder inside it) as a source.

## Notes

- **Where things live:** the library and accounts are in `/mnt/user/appdata/game-sauce/data`, covers in `.../storage`. Back up the `data` folder (the **Settings** page also has a backup).
- **Updating:** on the **Docker** tab choose **Check for Updates**, then **apply update** for game-sauce. Your library is kept.
- **The container runs as Unraid's usual `nobody:users` (99:100)**, the same as most Unraid apps, so it can read your shares and write its own folders.
- **Games are never changed:** the ROM folder is mounted read-only.
- It is **not yet in the Community Applications list**, which is why step 1 adds the template by hand.
