# Trace Autofix Studio plugin

This Rojo project builds the native Roblox Studio surface for Trace Autofix.
The current slice implements secure website pairing, session restoration, and
disconnect. Fix lists, script diffs, merge checks, and apply/undo arrive in the
next slice.

## Build

From the repository root:

```sh
rojo build plugin.project.json -o plugin/TraceAutofix.rbxmx
```

The generated `.rbxmx` contains the plugin `Script` and its `Api`, `Theme`, and
`Widget` `ModuleScript` children. It does not contain any scripts from the open
game.

For local development, enable **Plugin Debugging Enabled** in Studio settings.
Insert the built file into Studio, select its root `Script`, and choose
**Plugins → Save as Local Plugin**. Work from the copy under
`PluginDebugService`; use **Save and Reload Plugin** after rebuilding.

## Pairing flow

1. The plugin reads `StudioService:GetUserId()`, `game.GameId`, and
   `game.PlaceId`, then creates a ten-minute pairing request.
2. Trace opens `tracestack.gg/plugin-connect` in the browser. The signed-in
   website account must match the Roblox account open in Studio and must be an
   owner or admin of the Trace project mapped to the current Studio universe.
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
reserved for the mark and primary action; mint communicates a verified
connection. The widget opens docked right at 350×390 and remains usable down to
300×320.

The production API base URL is intentionally the non-secret constant
`https://api.tracestack.gg`. Local API changes should use a temporary build
override rather than committing credentials or local URLs.
