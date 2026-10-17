# YouTube Player Lab

Diagnostic ChatGPT MCP Apps player to test YouTube IFrame API playback (no downloading or proxying video).

Routes after deployment: `/health`, `/player` (Safari comparison), `/mcp` (ChatGPT MCP).

Deploy on Render using Node, `npm install --omit=dev`, `npm start`.

YouTube embedding can fail inside ChatGPT due to frame restrictions or referrer policy even when Safari standalone playback succeeds. Playback must be explicitly verified.

## Error 153 diagnostics

- YouTube defines 153 as a missing HTTP Referer or equivalent API client identity. It is separate from autoplay blocking and video embedding errors 101/150.
- The MCP resource embeds the same server's HTTPS `/player` page, declared as the only outer CSP `frameDomains` destination. The hosted page has its own document origin and declares `strict-origin-when-cross-origin`. YouTube's generated iframe also uses this policy in the observed environment. A configured policy is not proof that a request sent a Referer.
- Diagnostics distinguish the URL origin (`location.origin`) from the effective execution origin (`window.origin`). An opaque execution origin is reported as `null`; it is not replaced with an invented Render origin in player parameters.
- The incoming `document.referrer` identifies the referring page, not the header sent to YouTube. Only its origin is logged. An opaque sandbox may prevent an outgoing referrer even with the declared policy; another nested iframe cannot relax an ancestor's sandbox.
- Start playback with YouTube's own center play button. A separate API play button can be blocked by the host's autoplay policy. `onReady` is initialization only. Verify `onStateChange 1` plus increasing playback time before reporting success.
- The wrapper relays only a validated video ID from the MCP host to the exact player origin, including notifications received before the hosted frame loads. Other tool-result content is not forwarded.
- Existing ChatGPT cards can retain earlier HTML. Refresh the custom plugin and rerun it to use `ui://youtube-player-lab/https-player-v1.html`. The original resource URI remains available for compatibility. The hosted player shows diagnostic version `referrer-20261017-1`.

Observed on 2026-10-17 before the HTTPS wrapper: the existing card in ChatGPT web on Mac played for over 18 seconds and paused correctly after enabling CSP enforcement. The native Mac MCP Apps viewer reproduced error 153 with a `codex-sandbox://` URL origin, an empty incoming referrer, and an iframe already configured with `strict-origin-when-cross-origin`. This is evidence of a host-environment difference, not a direct capture of the outgoing HTTP header. Custom-scheme referrer handling needs investigation in the native host. The wrapper is a targeted mitigation: a network-loaded HTTPS child can supply its own origin if the ancestor sandbox permits it. An inherited opaque-origin restriction could still prevent playback. Native playback must be verified for the newly loaded wrapper before claiming success.

References: [YouTube errors](https://developers.google.com/youtube/iframe_api_reference#onError), [YouTube client identity](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-api-client-identity), [OpenAI widget CSP](https://developers.openai.com/plugins/reference#component-resource-_meta-fields), [effective origin](https://html.spec.whatwg.org/multipage/webappapis.html#dom-origin), [referrer algorithm](https://w3c.github.io/webappsec-referrer-policy/#determine-requests-referrer).
