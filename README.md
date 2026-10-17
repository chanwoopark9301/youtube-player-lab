# YouTube Player Lab

Official YouTube player for ChatGPT MCP Apps (no downloading or proxying video).

Routes after deployment: `/health`, `/player` (video only), `/diagnostics` (separate diagnostic player), `/mcp` (ChatGPT MCP).

Deploy on Render using Node, `npm install --omit=dev`, `npm start`.

YouTube embedding can fail inside ChatGPT due to frame restrictions or referrer policy even when Safari standalone playback succeeds. Playback must be explicitly verified.

## Player layout and pinned popup

The normal view contains the official YouTube player plus a compact toolbar outside the video. The wrapper and hosted page fill the available viewport without fixed pixel heights, outer margins, or document scrolling. Both iframe boundaries explicitly delegate fullscreen before navigation. Native YouTube fullscreen and the host app's fullscreen display mode are separate; a host restriction cannot be overridden by the child page. The earlier diagnostic UI remains available at `/diagnostics`.

- **팝업:** requests the host's pinned `pip` presentation so the player can remain visible during conversation.
- **팝업 후 전체화면:** first requests and verifies `pip`, then requests `fullscreen`. If already in confirmed PiP it requests fullscreen directly. It stops if the host rejects or substitutes a mode.
- **채팅으로:** requests `inline` presentation.

The component initializes the standard MCP Apps bridge and prefers `ui/request-display-mode`. `window.openai.requestDisplayMode` is a feature-detected compatibility fallback. Buttons respect advertised host modes, prevent overlapping requests, and report rejected, unconfirmed, or timed-out requests. The new toolbar does not intercept or cover YouTube's native fullscreen button. The [official PiP mode](https://developers.openai.com/plugins/concepts/ui-guidelines#picture-in-picture-pip) is a host-controlled floating surface, not a separate browser or OS window; fullscreen still depends on the host layout. Unit tests with a simulated host verify request behavior, not native Mac rendering.

## Error 153 diagnostics

- YouTube defines 153 as a missing HTTP Referer or equivalent API client identity. It is separate from autoplay blocking and video embedding errors 101/150.
- The MCP resource embeds the same server's HTTPS `/player` page, declared as the only outer CSP `frameDomains` destination. The hosted page has its own document origin and declares `strict-origin-when-cross-origin`. YouTube's generated iframe also uses this policy in the observed environment. A configured policy is not proof that a request sent a Referer.
- Diagnostics distinguish the URL origin (`location.origin`) from the effective execution origin (`window.origin`). An opaque execution origin is reported as `null`; it is not replaced with an invented Render origin in player parameters.
- The incoming `document.referrer` identifies the referring page, not the header sent to YouTube. Only its origin is logged. An opaque sandbox may prevent an outgoing referrer even with the declared policy; another nested iframe cannot relax an ancestor's sandbox.
- Start playback with YouTube's own center play button. A separate API play button can be blocked by the host's autoplay policy. `onReady` is initialization only. Verify `onStateChange 1` plus increasing playback time before reporting success.
- The wrapper relays only a validated video ID from the MCP host to the exact player origin, including notifications received before the hosted frame loads. Other tool-result content is not forwarded.
- Existing ChatGPT cards can retain earlier HTML. Refresh the custom plugin and rerun it to use `ui://youtube-player-lab/popup-v3.html`. Previous resource URIs remain available for compatibility. The diagnostic route shows version `referrer-20261017-1`.

Observed on 2026-10-17 before the HTTPS wrapper: the existing card in ChatGPT web on Mac played for over 18 seconds and paused correctly after enabling CSP enforcement. The native Mac MCP Apps viewer reproduced error 153 with a `codex-sandbox://` URL origin, an empty incoming referrer, and an iframe already configured with `strict-origin-when-cross-origin`. This is evidence of a host-environment difference, not a direct capture of the outgoing HTTP header. Custom-scheme referrer handling needs investigation in the native host. The wrapper is a targeted mitigation: a network-loaded HTTPS child can supply its own origin if the ancestor sandbox permits it. An inherited opaque-origin restriction could still prevent playback. Native playback must be verified for the newly loaded wrapper before claiming success.

After deploying the HTTPS wrapper, the native Mac viewer's hosted player reported both URL and execution origin as `https://youtube-player-lab.onrender.com`. Playback emitted `onStateChange 1`, and the actual video element advanced from 2.457856 to 21.66092 seconds with `paused: false`; pressing pause produced `paused: true` at 21.714547 seconds. The user also confirmed playback. This verifies the tested Mac environment, not every browser or mobile host, and does not directly capture the outgoing Referer header.

After the video-only layout deployment on 2026-10-17, the user confirmed that unwanted scrolling was gone. Fullscreen remains unresolved in the native Mac host: pressing YouTube's fullscreen button makes the ChatGPT app fullscreen without isolating the video. Standalone in-app-browser testing showed the YouTube fullscreen button switching to its exit state, but that does not verify native-host video-only fullscreen. Both iframe boundaries already delegate fullscreen, and the YouTube player uses `fs=1`. The host's handling of HTML fullscreen is a suspected cause, not a verified implementation detail. The SDK's `requestDisplayMode({mode: "fullscreen"})` is a separate host layout and [keeps the ChatGPT composer visible](https://developers.openai.com/plugins/concepts/ui-guidelines#fullscreen), so it is not a verified fix for this symptom. Do not describe native video-only fullscreen as fixed.

References: [YouTube errors](https://developers.google.com/youtube/iframe_api_reference#onError), [YouTube client identity](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-api-client-identity), [OpenAI widget CSP](https://developers.openai.com/plugins/reference#component-resource-_meta-fields), [effective origin](https://html.spec.whatwg.org/multipage/webappapis.html#dom-origin), [referrer algorithm](https://w3c.github.io/webappsec-referrer-policy/#determine-requests-referrer).
