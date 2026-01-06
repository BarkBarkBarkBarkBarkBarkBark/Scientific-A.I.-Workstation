# Scientific AI Workstation (SAW) — Frontend MVP

Desktop-style UI (Ableton-for-science vibe) to assemble pipelines from plugins, inspect nodes, and mock AI-assisted debugging/editing.

## Run

```bash
cd "/Scientific A.I. Workstation"
npm install
npm run dev
```

## Package Index

### Initial Install

```bash
docker compose up -d
```

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r services/saw_api/requirements.txt
python -m uvicorn services.saw_api.app.main:app --host 127.0.0.1 --port 5127
```

```bash
# Optional
export SAW_ENABLE_DB=1
export SAW_ENABLE_PLUGINS=1
npm run dev
```



### Scripts

```bash
npm run dev
npm run build
npm run preview
```

### Key Dependencies

- **React + TypeScript + Vite**
- **Tailwind CSS** (dark DAW theme)
- **Zustand** (single store for app state)
- **React Flow** (Graph layout)
- **Monaco Editor** (code editor + developer panel)

### Project Structure

- `src/components/`
  - `PluginBrowser.tsx`: left plugin list (drag source)
  - `PipelineBuilder.tsx`: Pipeline layout (drop zones + reorder + remove)
  - `NodeCanvas.tsx`: Graph layout (React Flow)
  - `Inspector.tsx`: node inspector + audio waveform UI
  - `BottomPanel.tsx`: Logs / Errors / AI / Dev tabs
- `src/store/useSawStore.ts`: Zustand store (nodes/edges/selection/layout/logs/AI/audio runtime)
- `src/mock/`: plugin catalog + mock AI planner
- `src/ai/client.ts`: frontend calls to dev-server AI proxy
- `src/audio/webaudio.ts`: decode MP3 + lowpass render (Web Audio)
- `vite.config.ts`: Vite dev-server proxy for OpenAI

## Core UX

### Layout Modes

Top bar → **Layout**
- **Pipeline**: list/rows, super reliable drag/drop (drop zones), supports **reorder** + **remove**
- **Graph**: freeform React Flow canvas

### Delete / Remove Steps

- **Pipeline**: click **Remove** on a step
- **Keyboard**: select a step/node then press **Delete** or **Backspace**

### Audio Lowpass Plugin (real)

Plugin: **Audio Lowpass**
- upload MP3
- adjust cutoff slider
- view original/filtered waveform
- play original/filtered (WebAudio)

## OpenAI (optional, local dev)

The browser calls a local dev proxy (`/api/ai/*`) so the API key is **not exposed to the frontend bundle**.

See `ENV_SETUP.md`.

