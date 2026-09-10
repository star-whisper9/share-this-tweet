`source-media.mp4` is a generated one-second blue frame and sine wave, not third-party media.
It exercises AVC/AAC tracks, fast-start, AAC roll-recovery groups, and existing metadata.
Generated with FFmpeg 8 development build (Lavf63.1.101):

```sh
ffmpeg -f lavfi -i color=c=blue:s=32x32:r=2 \
  -f lavfi -i sine=frequency=440:sample_rate=8000 -t 1 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -metadata comment='Original comment' \
  -metadata copyright='Original rights notice' \
  -movflags +faststart source-media.mp4
```

The test suite uses the committed fixture and does not require FFmpeg to be installed.
