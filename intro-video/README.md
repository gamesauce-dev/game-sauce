# Intro video

Scripts that build the game-sauce intro film (no narration: music and light captions) in eight languages. The finished videos and the `work/` folder are not kept in git.

Rough order (see the header comment of each script for its arguments):

1. Point `GS_URL`, `GS_USER` and `GS_PASS` at a running game-sauce, then record the live clips: `record-carousel.cjs`, `record-digital.cjs`, `record-shelf.cjs`. (`make-demo-games.cjs` fills a throwaway instance with invented games.)
2. Render the animated scenes frame by frame: `render-login.cjs`, `render-chat.cjs` (after `seed-chat.cjs`) and `render-ends.sh` (the logo ending, per language).
3. Put the licensed music at `work/music.mp3`, then `bash build.sh <lang>` for one language or `bash build-all.sh` for all. The words are in `captions/<lang>.sh`; `check-captions.sh` checks they fit.

Needs ffmpeg and Playwright with system Chrome. The website uses 720p copies of the films in `site/video/`.
