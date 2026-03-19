import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createNewServer() {
    const server = new McpServer({
        name: "weather-server",
        version: "1.0.0",
    });

    server.registerTool(
        "get_weather",
        {
            description: "Get current weather for a specific city",
            inputSchema: {
                city: z.string().describe("Name of the city"),
            },
        },
        async ({ city }) => {
            try {
                const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
                const geoResponse = await fetch(geoUrl);

                if (!geoResponse.ok) {
                    return {
                        content: [{ type: "text", text: `Error: Geocoding API returned ${geoResponse.status} ${geoResponse.statusText}` }],
                        isError: true,
                    };
                }

                const geoData = await geoResponse.json();
                if (!geoData.results || geoData.results.length === 0) {
                    return {
                        content: [{ type: "text", text: `Error: Location not found for city: ${city}` }],
                        isError: true,
                    };
                }

                const { latitude, longitude, name, country } = geoData.results[0];

                const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=auto`;
                const response = await fetch(url);

                if (!response.ok) {
                    return {
                        content: [{ type: "text", text: `Error: Weather API returned ${response.status} ${response.statusText}` }],
                        isError: true,
                    };
                }

                const data = await response.json();

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ location: `${name}, ${country}`, weather: data.current }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error fetching weather data: ${error.message}`,
                        }
                    ],
                    isError: true,
                };
            }
        }
    );

    server.registerTool(
        "review_code",
        {
            description: "Review local unstaged / staged changes in a git repository",
            inputSchema: {
                path: z.string().describe("Absolute path to the git repository"),
            },
        },
        async ({ path }) => {
            try {
                const { stdout: diffStdout } = await execAsync("git diff HEAD", { cwd: path });
                const { stdout: statusStdout } = await execAsync("git status -s", { cwd: path });

                if (!diffStdout) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "No changes found in the repository to review.",
                            },
                        ],
                    };
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: `Repository Status:\n${statusStdout}\n\nDiff:\n${diffStdout}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error retrieving git diff: ${error.message}`,
                        }
                    ],
                    isError: true,
                };
            }
        }
    );

    server.registerResource(
        "weather_report",
        "weather://global/current",
        { description: "A real-time weather report for major cities worldwide" },
        async (uri) => {
            try {
                const url = `https://api.open-meteo.com/v1/forecast?latitude=40.7143,51.5085,35.6895&longitude=-74.006,-0.1257,139.6917&current=temperature_2m,relative_humidity_2m,weather_code&timezone=auto`;
                const response = await fetch(url);

                if (!response.ok) {
                    throw new Error(`Weather API returned ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                const cities = ["New York", "London", "Tokyo"];

                let report = "# Global Weather Report (Real-time)\n\n";
                report += `Generated at: ${new Date().toISOString()}\n\n`;

                data.forEach((cityData, index) => {
                    report += `## ${cities[index]}\n`;
                    report += `- **Temperature**: ${cityData.current.temperature_2m}${cityData.current_units.temperature_2m}\n`;
                    report += `- **Humidity**: ${cityData.current.relative_humidity_2m}${cityData.current_units.relative_humidity_2m}\n`;
                    report += `\n`;
                });

                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "text/markdown",
                            text: report
                        }
                    ]
                };
            } catch (error) {
                console.error("Failed to fetch real-time weather report:", error);
                throw new Error("Failed to generate real-time weather report");
            }
        }
    );

    server.registerPrompt(
        "weather_demo",
        {
            description: "A prompt for an agent to check weather using the get_weather tool",
            argsSchema: { city: z.string().describe("The city to check weather for") }
        },
        ({ city }) => {
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `What is the current weather in ${city}? Please use the get_weather tool to find out and then summarize the result.`
                        }
                    }
                ]
            };
        }
    );

    return server;
}

const app = express();
app.use(cors());

// Map to store active transports by their session ID
// Key: sessionId, Value: SSEServerTransport
const transports = new Map();

app.get("/sse", async (req, res) => {
    try {
        // @ts-ignore : Required for Cursor's legacy SSE fallback on serverless platforms
        const transport = new SSEServerTransport("/sse", res);
        const server = createNewServer();
        await server.connect(transport);

        // Store the transport when the session is initialized
        if (transport.sessionId) {
            transports.set(transport.sessionId, transport);

            // Cleanup transport when connection closes
            res.on('close', () => {
                transports.delete(transport.sessionId);
                try {
                    transport.close();
                } catch (e) {
                    // Ignore close errors
                }
            });
        }
    } catch (error) {
        console.error("SSE connection error:", error);
        if (!res.headersSent) {
            res.status(500).send("Internal Server Error");
        }
    }
});

app.post("/sse", async (req, res) => {
    // The client SDK appends the sessionId to the message POST URL
    const sessionId = req.query.sessionId;

    if (!sessionId) {
        return res.status(400).send("No sessionId passed");
    }

    const transport = transports.get(sessionId);

    if (transport) {
        try {
            await transport.handlePostMessage(req, res);
        } catch (error) {
            console.error("Error handling post message:", error);
            res.status(500).send("Message handling failed");
        }
    } else {
        res.status(404).send(`No active SSE connection for session: ${sessionId}`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Weather MCP server running on SSE at http://localhost:${PORT}/sse`);
});

export default app;
