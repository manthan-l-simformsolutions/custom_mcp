import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export const config = {
    runtime: 'edge', // Forces Vercel to use Edge network (0ms cold start)
};

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

export default async function handler(req) {
    if (req.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Accept",
            }
        });
    }

    try {
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });

        // Vercel Edge Request headers are technically immutable, but we can clone the request headers to force the Accept header
        // required by the MCP strict specification
        const newReqHeaders = new Headers(req.headers);
        newReqHeaders.set('Accept', 'application/json, text/event-stream');

        const modifiedReq = new Request(req.url, {
            method: req.method,
            headers: newReqHeaders,
            body: req.body,
            duplex: 'half' // Required for Edge proxying
        });

        const server = createNewServer();
        await server.connect(transport);

        // Stateless initialization intercept
        const originalOnMessage = transport.onmessage;
        transport.onmessage = async (msg) => {
            if (msg.method !== 'initialize') {
                const fakeInit = {
                    jsonrpc: "2.0",
                    id: "stateless-init-hack",
                    method: "initialize",
                    params: {
                        protocolVersion: "2024-11-05",
                        capabilities: {},
                        clientInfo: { name: "vercel-edge-stateless", version: "1.0.0" }
                    }
                };

                const originalSend = transport.send;
                transport.send = async () => { };

                await originalOnMessage.call(transport, fakeInit);
                await originalOnMessage.call(transport, { jsonrpc: "2.0", method: "notifications/initialized" });

                transport.send = originalSend;
            }
            return originalOnMessage.call(transport, msg);
        };

        const response = await transport.handleRequest(modifiedReq);

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
    }
}
