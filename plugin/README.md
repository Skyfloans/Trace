# Trace Autofix Studio plugin

This Rojo project builds the native Roblox Studio surface for Trace Autofix. It
implements secure website pairing, a priority fix-request queue,
pull-request-style script diffs, rejection, and conflict-safe application.

## Build

From the repository root:

```sh
rojo build plugin.project.json -o plugin/TraceAutofix.rbxmx
```

The generated `.rbxmx` contains the plugin `Script` and its `Api`, `Theme`, and
`Widget` `ModuleScript` children. It does not contain any scripts from the open
game or any OpenRouter/Roblox OAuth secrets.

## Trace icon asset

Roblox toolbar and `ImageLabel` icons must use a Roblox-hosted image asset ID.
Upload `plugin/assets/trace-plugin-icon.png` as an image, then set
`TRACE_LOGO_IMAGE` in `plugin/src/init.server.luau` to
`rbxassetid://<your-image-id>` before building.

For local development, enable **Plugin Debugging Enabled** in Studio settings.
Insert the built file into Studio, select its root `Script`, and choose
**Plugins → Save as Local Plugin**. Work from the copy under
`PluginDebugService`; use **Save and Reload Plugin** after rebuilding.

## Pairing flow

1. The plugin reads `StudioService:GetUserId()`, `game.GameId`, and
   `game.PlaceId`, then creates a ten-minute pairing request.
2. Trace displays a secure `tracestack.gg/plugin-connect` link. Select it,
   press `Cmd+C` on macOS or `Ctrl+C` on Windows, and paste it into a browser.
   The signed-in website account must match the Roblox account open in Studio
   and must be an owner or admin of the Trace project mapped to the current
   Studio universe.
3. The website shows a two-digit, one-time number. The plugin submits that
   number together with a high-entropy proof returned only to this Studio
   request.
4. Trace returns a random, project-scoped plugin credential that expires after
   90 days and can be revoked. The plugin stores only this opaque credential
   with `Plugin:SetSetting`; Roblox OAuth tokens never enter the plugin.

The two-digit number is not the security boundary by itself. It is
request-bound, expires after ten minutes, allows five attempts, and is useless
without the 256-bit client proof.

## Theme and interaction

The widget uses `Studio.Theme:GetColor()` for its native canvas, input, border,
button, and text colors and rerenders on `Studio.ThemeChanged`. Trace coral is
reserved for primary actions; mint communicates a verified connection. The
uploaded Trace PNG has no backing tile. The widget opens docked right at
440×600 and remains usable down to 340×390.

## Review and apply

Connecting goes directly to the fix-request queue. The server checks the
priority list every ten minutes and keeps no more than 15 unresolved requests
for the project, ordered most critical first. Both the API and plugin cap the
visible inbox at those 15 current requests, so older diagnostics never flood
Studio. The compact inbox uses pull-request-style rows with a single-line title,
status and impact metadata, severity color, and consistent truncation at narrow
widget widths. The plugin refreshes the inbox automatically. Each ready request
opens a dark unified diff with old/new line numbers. Requests without a concrete
script edit are shown as diagnostics instead of empty code reviews; they can be
retried with the bounded cross-script investigation or dismissed. Reviewable
proposals can also be regenerated when the displayed diff addresses a symptom
instead of the root cause. Processing work has a two-minute lease; if a deploy
or worker interruption leaves a request stuck, the server automatically
requeues it.

Before accepting, the plugin resolves every proposed path and reads the current
editor source with `ScriptEditorService:GetEditorSource()`. If the source still
equals the snapshot, the proposed source is used directly. Otherwise each hunk
must match one unambiguous current block; unrelated newer edits are preserved
and edits in or around a hunk produce a conflict. Every file is validated
before writing. Updates use `ScriptEditorService:UpdateSourceAsync()` inside one
`ChangeHistoryService` recording, so the entire accepted fix is one Studio undo
action. Trace never publishes the place.

The production API base URL is intentionally the non-secret constant
`https://api.tracestack.gg`. Local API changes should use a temporary build
override rather than committing credentials or local URLs.
