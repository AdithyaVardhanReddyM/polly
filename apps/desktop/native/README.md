# Polly Sense

Polly Sense is the native macOS helper behind Polly's notch copilot. It reads what is on screen and can write text back into apps:

- **Accessibility API**: focused element, selection, visible text, form fields, page URL, and notifications while you work.
- **ScreenCaptureKit and Apple Vision**: window screenshots and OCR for apps that draw on a canvas.
- **Synthetic input**: setting values, pressing controls, pasting and typing when an element can't be written directly.

It is a Swift package (`PollySense/`, macOS 14+, no dependencies) built into a signed, Dock-less app bundle: `build/Polly Sense.app`.

## Build

```sh
npm run build:sense        # from the repo root or apps/desktop
```

The script runs `swift build -c release`, assembles `build/Polly Sense.app`, and signs it with the first "Apple Development" identity in your keychain. If there is none, it signs ad hoc and prints a warning. A stable identity matters because macOS ties the Accessibility and Screen Recording grants to the signature. An ad-hoc build loses them on every rebuild.

To check a build without Electron:

```sh
"build/Polly Sense.app/Contents/MacOS/PollySense" --selftest
```

This prints the hello, permissions, geometry and running-app count, plus a snapshot of the front window, as JSON. Run straight from a terminal like this, the helper uses the terminal's permissions, not its own.

## How Electron runs it

1. Electron listens on a Unix socket. Keep the path under 104 bytes; `os.tmpdir()` is fine.
2. Electron launches the helper:

   ```sh
   open -n -g "<path>/Polly Sense.app" --args --socket <socket-path>
   ```

   Launching through `open` makes Polly Sense its own "responsible process", so the permission prompts and the System Settings entries say "Polly Sense", not Polly or the terminal.
3. The helper connects and serves newline-delimited JSON. The protocol is defined in `apps/desktop/src/shared/sense.ts` and mirrored in `PollySense/Sources/PollySense/Protocol.swift`. Keep the two in step.
4. The helper exits when the socket closes, when it cannot connect within 5 s, or on `quit`.

Requests run concurrently, so responses can arrive out of order; match them by `id`. While `watch` is on, the helper sends `app`, `focus`, `typing`, `selection`, `content` and `visual` events. It sends `permissions` and `geometry` events whenever they change, whether or not it is watching.

## Permissions

| Permission | Used for | Without it |
|---|---|---|
| Accessibility | Reading elements, watching, writing, sending keys | Only app and window come from the window server. `ax` and `fields` are empty, and `write` and `script` return an error. |
| Screen Recording | Window captures for OCR, screenshots and visual checks | `ocr`, `screenshot` and `hash` are null. |

`requestPermission` shows the system prompt and opens the right pane of System Settings. The helper re-checks both permissions every 2 s and sends a `permissions` event when one changes. macOS may only report a new Screen Recording grant after the helper restarts.

## Logs

Logs go to the unified log:

```sh
log stream --predicate 'subsystem == "ai.polly.sense"'
```
