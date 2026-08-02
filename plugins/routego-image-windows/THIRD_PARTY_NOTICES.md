# Third-Party Notices

Routego Image is developed with reference to the following third-party project. This notice must remain in source and distributable packages whenever Routego Image includes copied or substantially adapted upstream material.

## gpt_image_playground

- Project: `CookSleep/gpt_image_playground`
- Repository: https://github.com/CookSleep/gpt_image_playground
- Audited commit: `a10477581b3d43ac98d39777e4445625a9db113d`
- Upstream version at the audited commit: `0.7.0`
- Copyright: `Copyright (c) 2026 CookSleep`
- License: MIT; the complete text is stored at `licenses/gpt_image_playground-MIT.txt`.

Foundation does not vendor the upstream repository, lockfile, dependencies, build configuration, or build outputs. Approved later reuse is limited to selected pure logic and protocol fixture concepts documented in `docs/development/upstream-provenance.md`. Files that substantially adapt upstream code must include a short source comment that references this notice and the audited commit.

## Dependency notices

This file does not treat the upstream dependency tree as Routego Image dependencies. The following notice is derived from Routego Image's own committed lockfile and distributable artifact.

### pngjs 7.0.0

- Project: `pngjs`
- Repository: https://github.com/pngjs/pngjs
- Version: `7.0.0`
- License: MIT
- Copyright: `Copyright (c) 2015 Luke Page & Original Contributors`; derived work `Copyright (c) 2012 Kuba Niegowski`
- Distribution: bundled pure-JavaScript runtime dependency; no native addon or install script is included in the Routego Image plugin.
- Complete license text: `licenses/pngjs-MIT.txt`

### onnxruntime-web 1.20.1

- Project: `ONNX Runtime Web`
- Repository: https://github.com/microsoft/onnxruntime
- Version: `1.20.1`
- License: MIT
- Distribution: bundled WebAssembly inference runtime for the verified local U²-Netp background-removal model; no native addon or dependency install script is included in the Routego Image plugin.
- Complete license text: `licenses/onnxruntime-web-MIT.txt`

### zod 4.4.3

- Project: `zod`
- Repository: https://github.com/colinhacks/zod
- Version: `4.4.3`
- License: MIT
- Distribution: bundled pure-JavaScript schema validation dependency; no native addon or install script is included in the Routego Image plugin.

The complete zod license text follows:

> MIT License
>
> Copyright (c) 2025 Colin McDonnell
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
