# YouTube Player Lab

Diagnostic ChatGPT MCP Apps player to test YouTube IFrame API playback (no downloading or proxying video).

Routes after deployment: `/health`, `/player` (Safari comparison), `/mcp` (ChatGPT MCP).

Deploy on Render using Node, `npm install --omit=dev`, `npm start`.

YouTube embedding can fail inside ChatGPT due to frame restrictions or referrer policy even when Safari standalone playback succeeds. Playback must be explicitly verified.
