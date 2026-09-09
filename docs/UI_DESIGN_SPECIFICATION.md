# Redaction Gate — UI Design & Surface Specification

This document provides a comprehensive breakdown of the User Interface (UI) design, visual hierarchy, components, data flows, and surfaces across the **Redaction Gate** browser extension.

---

## 1. Design Philosophy & Privacy Principles

The extension UI is designed around three core principles:
1. **Verifiable Zero-Knowledge**: The UI continuously displays verifiable evidence that raw PII never leaves the user's device.
2. **Real-Time Observability**: Full transparency into every step of the agent's perception, local neural inference, planning tier (Tier 0, 1, or 2), latency breakdown, and execution outcome.
3. **Dual Form Factor**: Adapts seamlessly between a compact browser action **Popup** (320px fixed width) and a docked, full-height **Side Panel** column.

---

## 2. Global Design System & Theming

The UI supports automated light and dark color schemes with high-contrast accessibility tokens optimized for displays and projectors.

### Color Palette

| Token | Light Mode | Dark Mode | Usage |
| :--- | :--- | :--- | :--- |
| `--bg` | `#ffffff` | `#14181e` / `#0f1319` | Surface background |
| `--fg` / `--ink` | `#12161c` | `#e7ebf1` / `#f2f5f9` | Primary typography |
| `--muted` | `#5b6472` | `#98a2b3` / `#aab4c2` | Secondary labels, captions, metadata |
| `--line` | `#e3e7ee` | `#29313b` / `#3a434f` | Borders, table dividers, panel frames |
| `--panel` | `#f4f6f9` | `#1b212a` / `#171c24` | Grouped cards, step logs, input containers |
| `--accent` | `#1b6feb` / `#0b5fd0`| `#5c9dff` / `#6aa9ff`| Action buttons, active tabs, highlights |
| `--ok` | `#17794a` / `#146c2e`| `#5bd08d` / `#6ede8a`| Step success (`ok`), ready states |
| `--warn` | `#8a5a00` / `#a8360f`| `#e0b25f` / `#ff9b7a`| Interrupted/stopped steps, local planner alerts |
| `--bad` | `#b3261e` | `#ff8a80` | Step failures, model rejection, 403 errors |

### Typography & Spacing
- **Font Stack**: `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- **Monospace Stack**: `ui-monospace, 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace` (for timings, tokens, coordinates, step indices)
- **Base Size**: 13px with 1.45 line height (compact desktop density)
- **Corner Radii**: 6px for interactive controls, cards, and textareas; 2px for overlay badges.

---

## 3. Extension UI Surfaces

```mermaid
graph TD
    A[Browser Extension UI] --> B[Popup / Agent View (popup.html / agent.html)]
    A --> C[Side Panel Container (panel.html)]
    A --> D[What Was Sent / Audit View (sidebyside.html)]
    A --> E[Resources & HUD (hud.html)]
    A --> F[In-Page Operator Overlay (Shadow DOM)]
    A --> G[Sensitive Action Confirmation (confirm.html)]

    C --> B
    C --> D
    C --> E
```

---

## 4. Detailed Component Breakdown

### Surface 1: Popup & Agent Control View (`popup.html` / `agent.html`)

This is the primary operational view where users provide instructions and monitor execution.

1. **Header & Lifecycle Status**:
   - **Title**: `Redaction Gate`
   - **Live Status Tag (`#status`)**: Displays current state: `idle` (grey), `running` (blue accent), `stopped` (amber), or `failed` (red).
2. **Cross-Tab Orientation Notice (`#tab-note`)**:
   - Appears in amber when the docked side panel is viewing a tab different from the one being operated by the agent.
   - Includes a **"Show it"** button to jump directly to the target tab.
3. **Goal Input Area (`#goal`)**:
   - Expandable textarea for user tasks (e.g. `"fill the form where first name is Dilip"`, `"check all the checkbox"`).
   - Real-time syntax / coverage validation indicator (`#coverage`).
4. **Primary Action Controls**:
   - **Run Button (`#run`)**: Starts task processing.
   - **Stop Button (`#stop`)**: Immediately cancels running agent loops.
   - **Overlay Toggle (`#overlay`)**: Checkbox that renders the in-page DOM bounding boxes and indices live on the webpage.
5. **Privacy Counter Box (`.counter`)**:
   - Displays: `Values protected this session: X · Values transmitted: 0`
   - The transmitted counter is permanently locked to `0` because raw PII never crosses process/network boundaries.
6. **Evidence & Diagnostic Navigation**:
   - **"What was sent" Button**: Opens the audit inspector.
   - **"Resources" Button**: Opens hardware & latency telemetry.
7. **System Diagnostics & Status Cards**:
   - **Planner Status (`#planner`)**: Shows active planner backend (`local (development) (ollama)` vs `remote (FastAPI server)`).
   - **Local Model Status (`#local-model`)**: Shows local on-device SLM health (e.g., `ready (qwen2.5:1.5b)`).
   - **Site Access (`#access`)**: Displays current site permission scope (`Any site. Granted by you` / `Revoke`).
   - **Inference Host (`#host`)**: Self-test status for local WebGPU / WASM execution (e.g. `webgpu + f16 - 1 thread - 1x8 in 12.4 ms`).
8. **Live Step Stream & Waterfall Log (`#log`)**:
   - Lists sequential steps (`#0`, `#1`, `#2`...) with overall duration.
   - Stage timing waterfall breakdown for each step:
     - `perceive`: DOM element extraction & scoring
     - `capture`: Viewport capture & screenshot hashing
     - `detect`: On-device AI/Regex PII detection (Aadhaar, PAN, email, etc.)
     - `seal`: Redaction box rendering & placeholder substitution
     - `plan`: Tier resolution / local model / remote vision model inference
     - `execute`: Browser DOM actuation (typing, clicking, toggling)
     - `settle`: MutationObserver quiescence check

---

### Surface 2: Side Panel Dock (`panel.html`)

A tabbed navigation container that docks alongside any open browser tab:
- **Tab Strip (`<nav role="tablist">`)**:
  - `Agent`: Embedded agent control panel.
  - `What was sent`: Side-by-side visual audit frame.
  - `Resources`: Real-time hardware telemetry.
- **Persistent View Containers (`<iframe>`)**:
  - Maintains state and in-memory object URLs across tab switches so evidence is preserved without re-fetching.

---

### Surface 3: "What Was Sent" Audit Inspector (`sidebyside.html`)

Allows operators to visually compare what the browser saw vs what was sent across the network.

```
+------------------------------------+------------------------------------+
|          Original Capture          |          Redacted Frame            |
|  [ Full webpage with actual text ] |  [ Blacked-out PII boxes & tokens] |
+------------------------------------+------------------------------------+
| Hover Interactive Inspection Table:                                     |
| Token         | Class      | Bounds (x, y, w, h)   | Confidence         |
| «AADHAAR_1»   | AADHAAR    | 120, 340, 180, 24     | 0.98               |
+-------------------------------------------------------------------------+
```

1. **Dual Frame Grid (`.frames`)**:
   - **Left Figure ("Original")**: Raw un-redacted viewport snapshot.
   - **Right Figure ("What was sent")**: Exact image transmitted to the planner, showing blacked-out redact blocks and Set-of-Mark numbered badges.
2. **Interactive Even-Odd SVG Veil**:
   - Hovering over any row in the findings table highlights the exact bounding box on both images simultaneously with an accent outline while dimming surrounding content.
3. **Findings Table**:
   - Lists all detected PII entities, placeholder tokens (`«PERSON_1»`, `«EMAIL_1»`), assigned classes, coordinates, and detection confidence.

---

### Surface 4: Performance & Resource HUD (`hud.html`)

Detailed telemetry for local machine learning and extension runtime:
1. **Inference Host Table**: Reports active backend (`WebGPU`, `WASM`, `CPU`), shader precision (`f16`, `f32`), thread count, and probe execution times.
2. **Memory Table**: On-device buffer allocations, model weights resident in VRAM/RAM, and canvas memory footprints.
3. **Latency Waterfall**: Bar charts illustrating millisecond breakdowns per stage for the current step.
4. **Latency Percentiles Table**: Accumulating p50 and p95 benchmarks across all session steps.

---

### Surface 5: In-Page Operator Overlay (`overlay.ts`)

Rendered directly inside the webpage tab within a **Closed Shadow DOM**:
- **Isolation**: Attached via `div#sih-redaction-gate-overlay` with a closed ShadowRoot and `:host { all: initial; }` to prevent page styles from affecting the overlay and vice versa.
- **Role-Based Color Coding**:
  - **Buttons**: Blue (`#1b6feb`)
  - **Links**: Purple (`#7d3cc7`)
  - **Textboxes / Searchboxes**: Green (`#17794a`)
  - **Dropdowns / Comboboxes**: Amber (`#b06000`)
  - **Checkboxes / Radios**: Cyan (`#0b7285`)
  - **IFrames**: Red (`#b3261e`)
- **Visual Badges**:
  - Numbered index labels attached to the top-left of each interactable element (`[17]`, `[18]`, `[19]`).
  - Dashed borders for newly appeared DOM elements.
  - Opacity reduction (45%) for partially occluded elements.

---

### Surface 6: Action Confirmation Modal (`confirm.html`)

A focused modal dialog that interrupts execution when high-risk actions occur:
- Summarizes the action (e.g. form submission, fund transfer, navigation).
- Provides explicit **"Proceed"** and **"Cancel"** buttons before allowing the agent to proceed.

---

## 5. Summary of UI File Structure

| File Path | Description |
| :--- | :--- |
| [`extension/src/ui/popup/popup.html`](file:///d:/visual%20automation%20agent%20extension/Visual-automation-agent-extension-main/extension/src/ui/popup/popup.html) | Standalone extension popup layout |
| [`extension/src/ui/popup/agent.html`](file:///d:/visual%20automation%20agent%20extension/Visual-automation-agent-extension-main/extension/src/ui/popup/agent.html) | Framed agent view embedded in the side panel |
| [`extension/src/ui/panel/panel.html`](file:///d:/visual%20automation%20agent%20extension/Visual-automation-agent-extension-main/extension/src/ui/panel/panel.html) | Tabbed Side Panel host layout |
| [`extension/src/ui/sidebyside/sidebyside.html`](file:///d:/visual%20automation%20agent%20extension/Visual-automation-agent-extension-main/extension/src/ui/sidebyside/sidebyside.html) | "What was sent" side-by-side audit inspector |
| [`extension/src/ui/hud/hud.html`](file:///d:/visual%20automation%20agent%20extension/Visual-automation-agent-extension-main/extension/src/ui/hud/hud.html) | Real-time performance & resource HUD |
| [`extension/src/ui/confirm/confirm.html`](file:///d:/visual%20automation%20agent%20extension/Visual-automation-agent-extension-main/extension/src/ui/confirm/confirm.html) | Operator confirmation modal |
| [`extension/src/content/overlay.ts`](file:///d:/visual%20automation%20agent%20extension/Visual-automation-agent-extension-main/extension/src/content/overlay.ts) | In-page Shadow DOM operator overlay renderer |
