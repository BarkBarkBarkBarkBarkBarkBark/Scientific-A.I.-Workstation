
# Scientific AI Workstation (SAW) — Executive Summary (for Senior TypeScript Review)

## 1. Product Overview

Scientific AI Workstation is a local-first, desktop-style UI to assemble scientific pipelines from plugins, inspect nodes, and use AI-assisted debugging/editing. The system is designed to be safe-by-default, requiring explicit approvals for file write operations.

## 2. High-Level Architecture

The UI communicates with a tool-calling agent (SAW API), which proxies safe filesystem operations through a Patch Engine. This “approval-gated” model enforces capabilities and prevents unintended writes.

## 3. Frontend Composition

`App.tsx` composes the main layout: top bar, goal box, plugin browser, pipeline/graph view, inspector, and bottom panel. The layout supports resizable sidebars and a resizable bottom panel for logs/AI/dev tools.

## 4. State Management (Zustand)

`useSawStore.ts` acts as the single source of truth for nodes, edges, AI state, chat, patch review, and workspace plugins. It defines core graph operations, AI interaction state, and UI layout state in one store module.

## 5. AI / Agent Integration

The frontend communicates with AI endpoints via `src/ai/client.ts`:

- `GET /api/ai/status` for availability.
    
- `POST /api/ai/plan` for plan generation.
    
- `POST /api/saw/agent/chat` for agent chat.
    
- `POST /api/saw/agent/approve` for approval flows.
    

## 6. Patch Proposal Handling

`parsePatchProposal.ts` parses AI outputs into structured patch proposals, supporting JSON-first parsing with a unified diff fallback. This enables safe, reviewed patch application in the UI.

## 7. Plugin System (Workspace Runtime)

`workspace.ts` fetches plugin metadata from the backend and normalizes it into frontend definitions (inputs, outputs, parameters). Plugins may include source paths for visibility into `plugin.yaml` and `wrapper.py` files.

## 8. Dependencies & Tooling

Core stack:

- React + TypeScript + Vite
    
- Tailwind CSS
    
- React Flow
    
- Zustand
    
- Monaco Editor