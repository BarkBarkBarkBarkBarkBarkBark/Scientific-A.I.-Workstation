# saw.utility.rag_explorer

Utility plugin that launches a Streamlit RAG explorer in a new browser tab.

## Notes
- Uses `SAW_API_URL` to call `/embed/upsert` and `/search/vector`.
- Stores the last running port in `.saw/utilities/saw.utility.rag_explorer.json` for reuse.
