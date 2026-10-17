# YouTube Player Lab

Diagnostic ChatGPT MCP Apps player to test YouTube IFrame API playback (no downloading or proxying video).

Routes after deployment: `/health`, `/player` (Safari comparison), `/mcp` (ChatGPT MCP).

Deploy on Render using Node, `npm install --omit=dev`, `npm start`.

YouTube embedding can fail inside ChatGPT due to frame restrictions or referrer policy even when Safari standalone playback succeeds. Playback must be explicitly verified.

## Error 153 diagnostics

- YouTube defines 153 as a missing HTTP Referer or equivalent API client identity. It is separate from autoplay blocking and video embedding errors 101/150.
- The player HTML declares `strict-origin-when-cross-origin`, including when delivered as an MCP resource. The YouTube IFrame API also sets this policy on its generated iframe in the observed desktop environment. An explicit policy is not proof that a request sent a Referer.
- Diagnostics distinguish the URL origin (`location.origin`) from the effective execution origin (`window.origin`). An opaque execution origin is reported as `null`; it is not replaced with an invented Render origin in player parameters.
- The incoming `document.referrer` identifies the referring page, not the header sent to YouTube. Only its origin is logged. An opaque sandbox may prevent an outgoing referrer even with the declared policy; another nested iframe cannot relax an ancestor's sandbox.
- Start playback with YouTube's own center play button. A separate API play button can be blocked by the host's autoplay policy. `onReady` is initialization only. Verify `onStateChange 1` plus increasing playback time before reporting success.
- Existing ChatGPT cards can retain earlier HTML. Close and reopen the app viewer (or refresh the plugin and run it again) and check for diagnostic version `referrer-20261017-1`.

References: [YouTube errors](https://developers.google.com/youtube/iframe_api_reference#onError), [YouTube client identity](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-api-client-identity), [OpenAI widget CSP](https://developers.openai.com/plugins/reference#component-resource-_meta-fields), [effective origin](https://html.spec.whatwg.org/multipage/webappapis.html#dom-origin), [referrer algorithm](https://w3c.github.io/webappsec-referrer-policy/#determine-requests-referrer).
