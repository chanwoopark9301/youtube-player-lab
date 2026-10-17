# Conversational video assistant: agreed intent and implementation boundary

Status: implementation in progress. The user rejected Gemini integration. Use direct public captions without a separate analysis provider. This document is a design, not a shipped feature claim.

## User outcome

On mobile and Mac, the user asks ChatGPT to play a YouTube video, asks questions about its spoken/subtitle content, changes the video by speaking or typing, and receives recommendations based on the conversation and subsequent feedback. Visual scene analysis is not required. Recommendations explain why each choice fits. “Play the second one” resolves to the second item in the latest recommendation list.

## Responsibilities

- ChatGPT uses the conversation it can actually access to infer interests, language, difficulty, and feedback. It must not claim access to every past chat. Full conversation history is not collected by the MCP server.
- The server supplies verified candidate metadata, player commands and acknowledgments, and explicitly sourced content evidence. It does not independently invent personalized reasons.
- The existing official YouTube iframe remains the playback surface. The clean video layout and separate external player buttons remain available.

## Data and identity

Each recommendation result is an ordered list with a result ID and validated video IDs. Selection identifies the list and item, rather than relying on an unversioned global “second video.” Candidate title, channel and availability are checked against a real source. Search is either a verified host search capability or a separately configured YouTube Data API connection; no fabricated video IDs and no claim that host search is a server feature.

Each visible player has its own expiring, unguessable capability and revision. Commands name that player and revision. Only the player’s actual state/time and matching acknowledgment establish playback success. An open request, cue request, or queued command is not a playback acknowledgment. There is no global current video shared by users.

Content evidence always identifies video ID, source type, language when known, acquisition time, and any covered time range. A switch changes the revision and clears the old content association immediately. Late responses for earlier video revisions cannot update current context. Answers for a previous video remain possible only when the user explicitly asks about it.

The separate player tab requires a server control channel because it opens with `noopener`. Do not assume that opening a new MCP card updates an existing external tab. Expired/restarted sessions must reconnect visibly and cannot be reported as still playing.

## Content-source choice

Use the public watch/player/timedtext text path. Local direct HTTP probes retrieved actual timestamped captions for two public videos without credentials, proxies, or media downloads. Implement the same path in Node and verify it separately from the Render IP. If YouTube denies the request, requires login/challenge, or has no captions, return that specific failure without bypassing it. A provided transcript remains an explicitly labeled fallback; video metadata is never a substitute for spoken-content evidence. No Gemini connection or API-key onboarding.

YouTube Data API caption download does not provide arbitrary public-video transcripts: it requires OAuth and permission to edit the video. An API key for search does not solve that restriction. Desktop browser transcript export was tested for one sample but is not the mobile/server solution.

## Delivery and validation

Implement direct public search/captions, visible player control and latest-video context, then model-grounded recommendations and answers. Existing playback remains deployed while these changes are developed and reviewed. Provider/key onboarding is not a dependency.

Meaningful checks cover invalid/duplicate candidates, unavailable metadata, two unrelated player sessions, unauthorized/expired sessions, command acknowledgment versus queuing, A→B switching during an in-flight A content request, denied autoplay, provider errors, and sourced answers that belong to the selected video. Provider fixtures prove parsing/error handling only; a live API request is required to claim provider integration. Mac and mobile rendering, playback, and external navigation need separate device checks.

## Official references checked on 2026-10-17

- [MCP Apps model context and widget state](https://developers.openai.com/plugins/build/chatgpt-ui#keep-temporary-ui-state-in-the-ui)
- [YouTube caption download permissions](https://developers.google.com/youtube/data/reference/rest/v3/captions/download)
- [YouTube search API](https://developers.google.com/youtube/data/reference/rest/v3/search/list)
- [Google YouTube URL video understanding](https://ai.google.dev/gemini-api/docs/video-understanding#pass-youtube-urls)
