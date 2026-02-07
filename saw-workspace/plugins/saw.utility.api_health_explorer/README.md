# saw.utility.api_health_explorer

Utility plugin that launches a Streamlit API explorer in a new browser tab.

## Notes
- Reads `saw-workspace/machine-context/api_endpoints.json` for endpoint metadata.
- Stores the last running port in `.saw/utilities/saw.utility.api_health_explorer.json` for reuse.
