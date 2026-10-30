#!/usr/bin/env sh
# Regenerates tests/fixture/audio/music-bed.m4a: a 24 s synthetic, royalty-free "mastered" music bed made only with ffmpeg.
# - steady 55 Hz bass (speech has almost no energy there, so tests can measure the bed level UNDER narration with a low-pass)
# - chord pad changing every 2 s (A minor / F / C / G) + soft pulses; loudness-normalised loud (-12 LUFS, -0.5 dBTP)
#   so the mix limiter is actually exercised.
set -eu
cd "$(dirname "$0")"
ffmpeg -v error -y -f lavfi -i "aevalsrc='0.30*sin(2*PI*55*t)+0.10*sin(2*PI*(220+eq(mod(floor(t/2),4),1)*(-45.4)+eq(mod(floor(t/2),4),2)*(41.6)+eq(mod(floor(t/2),4),3)*(-24.0))*t)+0.08*sin(2*PI*(261.6+eq(mod(floor(t/2),4),1)*(-41.6)+eq(mod(floor(t/2),4),3)*(32.4))*t)+0.07*sin(2*PI*(329.6+eq(mod(floor(t/2),4),1)*(19.4)+eq(mod(floor(t/2),4),2)*(62.4)+eq(mod(floor(t/2),4),3)*(-36.0))*t)+0.12*sin(2*PI*880*t)*exp(-12*mod(t,0.5))|0.30*sin(2*PI*55*t)+0.09*sin(2*PI*(220+eq(mod(floor(t/2),4),1)*(-45.4)+eq(mod(floor(t/2),4),2)*(41.6)+eq(mod(floor(t/2),4),3)*(-24.0))*t)+0.09*sin(2*PI*(261.6+eq(mod(floor(t/2),4),1)*(-41.6)+eq(mod(floor(t/2),4),3)*(32.4))*t)+0.07*sin(2*PI*(329.6+eq(mod(floor(t/2),4),1)*(19.4)+eq(mod(floor(t/2),4),2)*(62.4)+eq(mod(floor(t/2),4),3)*(-36.0))*t)+0.12*sin(2*PI*660*t)*exp(-12*mod(t+0.25,0.5))':s=48000:d=24" \
  -af "loudnorm=I=-12:TP=-0.5:LRA=7" -ar 48000 -c:a aac -b:a 160k music-bed.m4a
