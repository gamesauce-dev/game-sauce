#!/usr/bin/env bash
# The English intro cut, with the music in work/music.mp3 (put the licensed track there). Run from this folder after render-login.cjs and render-chat.cjs:  bash build-en.sh [output.mp4]
# Pictures: the animated sign-in scene (work/login-frames), the website's demo clips (../site/video), the Digital screenshot (../site/img), the live chat scene (work/chat-frames); captions are drawn here.
# Length 73.7 s. The music is cut at the end of the film and faded out over its last 0.8 s; a track shorter than the film is repeated.
set -euo pipefail
cd "$(dirname "$0")"
FF=${FFMPEG:-ffmpeg}
OUT=${1:-game-sauce-intro-en-v12.mp4}
LEN=73.7
cap() {   # cap "text" size y from to : a caption that fades in and out between two moments of its own segment
  local text="$1" size="$2" y="$3" t0="$4" t1="$5"
  printf "drawtext=fontfile=work/font.ttf:text='%s':fontsize=%s:fontcolor=white:box=1:boxcolor=0x0b0c10@0.62:boxborderw=24:x=(w-text_w)/2:y=%s:alpha='if(lt(t,%s),0,if(lt(t,%s+0.4),(t-%s)/0.4,if(lt(t,%s-0.4),1,if(lt(t,%s),(%s-t)/0.4,0))))'" "$text" "$size" "$y" "$t0" "$t0" "$t0" "$t1" "$t1" "$t1"
}
CLIP="scale=1920:1080:flags=lanczos,fps=30,setsar=1"
{
# 5.6 s  the sign-in scene (it ends on the white flash)
echo "[0:v]format=yuv420p,setsar=1,$(cap 'Ready player one?' 56 'h-118' 0.9 4.3)[a0];"
# 8.0 s  the library, fading in from the flash
echo "[1:v]trim=start=0.5:duration=8,setpts=PTS-STARTPTS,$CLIP,fade=t=in:st=0:d=0.5:color=white,$(cap 'Welcome to your collection.' 58 'h-170' 1.0 3.2),$(cap 'Every game you own. Covers and details, found for you.' 50 'h-170' 3.5 7.6)[a1];"
# 7.5 s  play in the browser
echo "[2:v]trim=start=3.6:duration=7.5,setpts=PTS-STARTPTS,$CLIP,$(cap 'Press play. Right in the browser.' 58 'h-170' 0.8 7.1)[a2];"
# 12.0 s  the Carousel, recorded from the demo library (16.6 s of it at 1.4 times the speed): scrolling, stars, the A-Z rail
echo "[3:v]trim=start=2.2:duration=16.6,setpts=(PTS-STARTPTS)/1.4,$CLIP,$(cap 'Spin through the whole collection.' 58 'h-170' 0.8 4.3),$(cap 'Jump to any letter. Star your favourites.' 54 'h-170' 5.0 11.4)[a3];"
# 8.5 s  Big Screen
echo "[4:v]trim=start=0.3:duration=8.5,setpts=PTS-STARTPTS,$CLIP,$(cap 'Then take it to the sofa.' 58 'h-170' 0.7 3.8),$(cap 'Big Screen. Gamepad in hand, everything on the TV.' 52 'h-170' 4.1 8.1)[a4];"
# 13.0 s  the shelf, recorded live from the real shelf (22.1 s at 1.7 times the speed): the spines, one pulled out with its video playing, the case brought forward, turned over, opened to the booklet and disc, the manual read
echo "[5:v]trim=start=5.0:duration=22.1,setpts=(PTS-STARTPTS)/1.7,$CLIP,$(cap 'Your boxed games too.' 58 'h-130' 0.5 3.0),$(cap 'Pull one out, and its video plays.' 54 'h-130' 3.3 6.5),$(cap 'Turn it, open it, read the manual.' 54 'h-130' 6.9 12.4)[a5];"
# 8.5 s  the Digital library, recorded live: Steam and the console games, the logos as chips (zoomed on the chips and the first row of covers)
echo "[6:v]trim=start=2.5:duration=9.6,setpts=(PTS-STARTPTS)/1.13,crop=960:540:0:40,scale=1920:1080:flags=lanczos,fps=30,setsar=1,format=yuv420p,$(cap 'Your Steam library too.' 58 'h-130' 0.6 3.0),$(cap 'And the console games you own.' 58 'h-130' 3.2 5.6),$(cap 'Use your own logos as chips.' 58 'h-130' 5.9 8.1)[a6];"
# 8.4 s  chat, recorded live
echo "[7:v]format=yuv420p,setsar=1,$(cap 'Keep in touch with the household.' 58 'h-250' 1.0 4.2),$(cap 'Private messages. No cloud.' 58 'h-250' 4.6 8.0)[a7];"
# 5.2 s  the end card: the animated logo
echo "[9:v]format=yuv420p,setsar=1[a8];"
echo "[a0][a1]concat=n=2:v=1:a=0,settb=1/30,fps=30[c1];"
echo "[c1][a2]xfade=transition=fade:duration=0.4:offset=13.2[x2];"
echo "[x2][a3]xfade=transition=fade:duration=0.4:offset=20.3[x3];"
echo "[x3][a4]xfade=transition=slideleft:duration=0.4:offset=31.9[x4];"
echo "[x4][a5]xfade=transition=fade:duration=0.4:offset=40.0[x5];"
echo "[x5][a6]xfade=transition=fade:duration=0.4:offset=52.6[x6];"
echo "[x6][a7]xfade=transition=slideleft:duration=0.4:offset=60.7[x7];"
echo "[x7][a8]xfade=transition=fade:duration=0.6:offset=68.5,format=yuv420p[v];"
# the music, quieter for the picture, cut to the film and faded out
echo "[8:a]volume=-13dB,atrim=0:$LEN,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.05,afade=t=out:st=$(awk "BEGIN{print $LEN-0.8}"):d=0.8[aout]"
} > work/filter-en.txt
"$FF" -hide_banner -loglevel error -y -framerate 30 -i work/login-frames/f%04d.png -i ../site/video/library.mp4 -i ../site/video/play.mp4 -i work/carousel-live.webm -i ../site/video/bigscreen.mp4 -i work/shelf-live.webm \
  -i work/digital-live.webm -framerate 30 -i work/chat-frames/f%04d.png -stream_loop -1 -i work/music.mp3 -framerate 30 -i work/end-frames/f%04d.png \
  -/filter_complex work/filter-en.txt -map "[v]" -map "[aout]" -t "$LEN" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k -movflags +faststart "$OUT"
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of default=nw=1 "$OUT"
