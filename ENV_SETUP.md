# Environment Setup (Local Dev)

This app is frontend-first, but the **OpenAI API key is read by the Vite dev server** (Node) via a local proxy endpoint, so your key is **not shipped to the browser**.

## Option A: export env vars in your shell (recommended)

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4o-mini"   # optional
npm run dev
```

## Option B: create a local `.env` (you do this manually)

Create a `.env` file in the project root:

```bash
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-4o-mini"
```

Then:

```bash
npm run dev
```

## Notes

- If no key is set, the app falls back to a mocked AI planner.
- This proxy is for **local dev**; for production you’d host a real backend/proxy.


