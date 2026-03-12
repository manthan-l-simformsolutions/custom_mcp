# Weather Server (MCP)

A custom Model Context Protocol (MCP) server that provides tools for fetching weather data and reviewing local git repository changes.

## Features

This server exposes the following MCP tools:

### 1. `get_weather`
Get the current weather for a specific city.
- **Input:** `city` (string) - Name of the city.
- **How it works:** Uses the free [Open-Meteo Geocoding API](https://open-meteo.com/) to resolve the city's location (latitude/longitude), and then fetches current weather metrics such as temperature, relative humidity, apparent temperature, precipitation, wind speed, wind direction, and more from the Open-Meteo Forecast API. No API keys are required.

### 2. `review_code`
Review local unstaged and staged changes in a Git repository.
- **Input:** `path` (string) - Absolute path to the Git repository.
- **How it works:** Executes `git diff HEAD` and `git status -s` in the specified directory to extract and return the repository's current status and file diffs.

## Installation

Ensure you have Node.js installed, then install the required dependencies:

```bash
npm install
```

## Usage

To run the MCP server, execute:

```bash
npm start
```

This will run `node index.js` and start the server communicating over standard input/output (stdio), which can be integrated with any compatible MCP client.

## Technologies Used

- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) - The MCP server and standard I/O transport.
- [Zod](https://zod.dev/) - For robust schema validation on tool inputs.
- `child_process.exec` - For running local Git commands.
