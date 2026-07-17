---
name: Trace Portal
description: Evidence-first Roblox error investigation
colors:
  trace-coral: "#ed7b66"
  game-blade-ball: "#d96e58"
  game-pet-haven: "#8979d8"
  game-skybound: "#438fa5"
  workspace: "#121a23"
  navigation: "#0e151d"
  surface: "#18232d"
  surface-raised: "#1e2b36"
  ink: "#f0f4f6"
  muted: "#aebbc5"
  divider: "#2b3945"
  error: "#ff9b92"
  warning: "#e8c47a"
  info: "#82c9e5"
  success: "#7ed1ad"
  focus: "#9ec7ff"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.3
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "42px"
components:
  button-primary:
    backgroundColor: "{colors.trace-coral}"
    textColor: "{colors.navigation}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "44px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 13px"
    height: "44px"
  navigation-item:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "44px"
---

# Design System: Trace Portal

## Overview

**Creative North Star: "The Evidence Workbench"**

Trace is a calm technical workspace for developers reconstructing what happened inside a Roblox session. It should feel durable and exact: controls stay familiar, evidence remains visually dominant, and decoration never competes with the investigation.

The system is dark because it is designed for focused debugging sessions in mixed or low ambient light. Its personality comes from disciplined density, coral wayfinding, and side-by-side evidence—not from glass effects, exaggerated rounding, or theatrical motion.

**Key Characteristics:**
- Evidence-first hierarchy with compact, labeled controls.
- Flat tonal layers separated by lightness and hairline dividers.
- Restrained semantic color that always carries meaning.
- Full keyboard, touch, and narrow-screen usability.

## Colors

The palette uses blue-charcoal neutrals with a restrained coral brand signal and explicit semantic roles.

### Primary
- **Trace Coral:** Reserved for brand recognition, current location, focus-adjacent emphasis, and the rare primary action.

### Secondary
- **Session Violet:** Used only to distinguish server-series data from client-series data.
- **Integrated Game Identities:** Blade Ball coral, Pet Haven violet, and Skybound teal appear only inside game identity marks.

### Neutral
- **Deep Workspace:** The application canvas.
- **Navigation Well:** The persistent navigation layer.
- **Evidence Surface:** Standard controls and grouped evidence.
- **Raised Evidence Surface:** Menus, selected navigation, and transient feedback.
- **Operational Ink:** Primary text.
- **Muted Steel:** Secondary text that still meets WCAG AA.
- **Structural Divider:** Hairlines and input boundaries.

### Semantic
- **Error Rose:** Failures and selected error evidence.
- **Warning Amber:** Degraded or risky events.
- **Information Cyan:** Informational events and client evidence.
- **Healthy Mint:** Connected and healthy states.

**The Evidence Color Rule.** Color must identify state, source, selection, or action. Decorative color is prohibited.

**The Coral Budget Rule.** Trace Coral occupies less than 10% of a screen. Its rarity is what makes it useful.

## Typography

**Display Font:** Inter with the system UI stack
**Body Font:** Inter with the system UI stack
**Label/Mono Font:** SFMono-Regular / Menlo / system monospace

**Character:** One restrained sans family keeps the product familiar and fast. Monospace is reserved for timestamps, sources, IDs, and raw evidence.

### Hierarchy
- **Headline** (650, 30px, 1.15): Page identity only.
- **Title** (650, 16px, 1.3): Section and evidence headings.
- **Body** (400, 14px, 1.5): Explanations and interface copy, capped near 68 characters where prose appears.
- **Label** (650, 12px, 1.3): Persistent field and table labels.
- **Data** (400, 12px, 1.5): Logs and technical metadata.

**The Operational Readability Rule.** No meaningful text may fall below 12px on desktop or 14px for mobile prose. Low-contrast metadata is forbidden.

## Elevation

Trace is flat by default. Depth comes from a three-step tonal surface scale and one-pixel structural dividers. Shadows are limited to transient menus and toast notifications, where overlap must be explicit.

### Shadow Vocabulary
- **Transient Overlay** (`0 18px 50px rgba(0,0,0,.28)`): Menus only.
- **Status Toast** (`0 14px 40px rgba(0,0,0,.30)`): Temporary system feedback only.

**The Tonal-First Rule.** Permanent content never receives a decorative shadow. Raise the surface lightness before adding elevation.

## Components

### Buttons
- **Shape:** Restrained curves (6–10px radius), never capsules by default.
- **Primary:** Trace Coral with dark ink, 44px minimum target.
- **Hover / Focus:** Tonal background shift and a 2px Focus Blue outline.
- **Secondary / Ghost:** Evidence Surface or transparent background with explicit text.

### Chips
- **Style:** Compact semantic badge with a 6px radius and a dark same-hue surface.
- **State:** Text always accompanies color; badges never act as unexplained icons.

### Cards / Containers
- **Corner Style:** 10–14px only where a boundary improves comprehension.
- **Background:** Evidence Surface against the Deep Workspace.
- **Shadow Strategy:** None for permanent content.
- **Border:** One-pixel Structural Divider.
- **Internal Padding:** 12–16px.

### Inputs / Fields
- **Style:** Evidence Surface, 1px divider, 10px radius, visible label.
- **Focus:** Focus Blue outline or an equivalent focus-within ring.
- **Error / Disabled:** Error Rose with plain-language guidance; reduced opacity alone is insufficient.

### Navigation
- Desktop uses a fixed side rail with labeled 44px rows. Mobile uses a persistent safe-area-aware bottom bar. Current location is communicated by text color, background, icon color, and `aria-current`.

### Evidence Workspace
- Client and server logs may appear side by side on desktop and stack on mobile.
- Selected evidence appears above the log panes with source, timing, correlation, copy, export, and share actions.
- Raw evidence uses monospace; interpretation and controls use the UI sans.

## Do's and Don'ts

### Do:
- **Do** keep the selected event, its timestamp, source, and correlation context visible together.
- **Do** use 44px minimum targets and preserve full investigation capability on mobile.
- **Do** keep body and placeholder contrast at WCAG AA or better.
- **Do** use semantic tokens for every active color and operational text role.
- **Do** use motion only for menu entry, state feedback, and temporary status.

### Don't:
- **Don't** use glassmorphism, decorative blur, gradient text, or gradient avatars.
- **Don't** repeat pill-shaped controls across the interface.
- **Don't** nest cards or add containers where spacing and alignment are enough.
- **Don't** use side-stripe borders as state accents.
- **Don't** hide core navigation or investigation actions on mobile.
- **Don't** present inert controls as if they work.
- **Don't** use color without a text label or another non-color cue.
