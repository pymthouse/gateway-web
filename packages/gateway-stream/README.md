# @pymthouse/gateway-stream

Optional MPEG-TS media layer for trickle jobs that need frame encode/decode. Depends on `node-av` (native FFmpeg bindings). Install this package only when you publish or consume video frames; `@pymthouse/gateway-web` trickle transport stays undici-only.

```bash
npm install @pymthouse/gateway-stream
```

`node-av` runs install scripts that download FFmpeg binaries. Do not pass `--ignore-scripts` when installing this package.

```ts
import { MediaPublish, MediaOutput, publishFile } from "@pymthouse/gateway-stream";

const pub = new MediaPublish(inUrl);
await pub.writeFrame({ width: 640, height: 360, data: yuv420p });
await pub.close();
```
