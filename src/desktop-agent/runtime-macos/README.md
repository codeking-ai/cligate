# runtime-macos

This directory is the **deployment target** for the compiled macOS desktop-agent
helper. It is intentionally empty of binaries in source control.

`src/desktop-agent/backends/macos-native.js` resolves the helper at:

```
src/desktop-agent/runtime-macos/cligate-desktop-agent
```

(and the `app.asar.unpacked` equivalent inside a packaged Electron build).

The binary is produced from the Swift source in **`native/macos-desktop-agent/`**
and copied here by `native/macos-desktop-agent/build.sh`. On Windows/Linux this
directory is never read — `backends/index.js` only selects the macOS backend when
`process.platform === 'darwin'`.

Do **not** commit the compiled binary; build it as part of the macOS release /
packaging step.
