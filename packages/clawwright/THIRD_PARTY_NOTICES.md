# Third-party notices

## OpenClaw

Clawwright includes an adapted Docker Compose definition based on the upstream OpenClaw
project. The upstream project is available at:

https://github.com/openclaw/openclaw

The adapted file is `packages/clawwright/docker-compose.yml` in source form and
`dist/docker-compose.yml` in the npm package. Changes made by Clawwright include the image-only
workflow, explicit host bind mounts, loopback-by-default port publishing, and the healthcheck.
Clawwright does not distribute the OpenClaw image or its source code; users obtain the image
separately from the configured container registry.

OpenClaw is distributed under the MIT License, reproduced here as its terms require for the
adapted file:

```text
MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## App-owned recipe sources

Recipes are application-owned and may clone or build their own upstream sources at build time.
They are not part of the `clawwright` npm package; review each recipe's source,
license and pin before enabling or redistributing it.
