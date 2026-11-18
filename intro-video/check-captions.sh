#!/usr/bin/env bash
# one picture per language with all the captions stacked at their real size, to see whether any is too wide for the screen
cd "$(dirname "$0")"
for l in "$@"; do
  source "captions/$l.sh"
  f="color=c=0x333333:s=1920x1180:d=1"
  y=10
  for i in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16; do
    v="C$i"; t="${!v}"
    case $i in 03|08|06|10|11|13|05|04|09|12|14|15|16|01|02|07) size=58;; esac
    case $i in 03) size=50;; 06) size=54;; 08) size=52;; 10|11) size=54;; esac
    size=$(awk "BEGIN{printf \"%d\", $size*$FS}")
    f="$f,drawtext=fontfile=$FONT:text='$t':fontsize=$size:fontcolor=white:box=1:boxcolor=0x0b0c10@0.62:boxborderw=24:x=(w-text_w)/2:y=$y"
    y=$((y+72))
  done
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$f" -frames:v 1 work/capcheck-$l.png && echo "$l ok"
done
