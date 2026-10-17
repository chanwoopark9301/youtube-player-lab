# 대화형 영상 도우미 검증 기록

2026-10-17. 목표는 모바일·맥에서 대화로 재생/전환, 실제 말·자막 근거 답변, 접근 가능한 대화에 맞춘 추천이다. 아래 부분 진척을 전체 목표 완료로 해석하지 않는다.

## 배포와 검사

- main `8bec6521c91720089e5f1c95fef6a8e7501abea6`, Render `dep-db9nq42vcj2c739gbv30` live.
- 전체 90/90 테스트, 문법·공백 검사 통과. 공개 자막 모듈은 Node 20.20.2 테스트도 통과했다.
- 배포된 `/mcp`의 tools/list에 open/search/control/state/transcript 다섯 도구가 있다. 웹의 youtube lab 설정에서 도구 새로 고침을 실행했고 버튼이 비활성→활성으로 복귀했다. 현재 진행 중인 에이전트의 연결 도구 캐시는 기존 open 도구만 보이므로, 새 대화/다음 turn의 실제 도구 발견은 별도 확인이 필요하다.

## 실제 결과

| 요구 | 확인한 증거 | 남은 일 |
| --- | --- | --- |
| 맥 플레이어 열기 | 새 MCP 카드가 UI 전용 연결 정보를 받아 `controlState=connected`, 실제 영상 ID를 보고함 | 사용자 전경 클릭으로 5초 이상 지속 재생 확인 |
| 열린 영상 바꾸기 | 배포된 HTTPS 앱 브라우저에서 select 후 `M7lc1UVf-VE`→`jNQXAC9IVRw`, revision2, 실제 ACK1, playing0.44초→paused0.62초 관측 | 자동 조작에서 빠른 일시정지 원인 미확정. 지속 재생 성공으로 주장하지 않음 |
| 대화 기반 추천 | Render 검색이 실제 videoId/title/channel 3개 반환. 대화에서 짧은 query를 만들며 전체 대화 저장 없음 | 갱신된 호스트 도구로 추천→두 번째 재생 사용자 흐름 검증 |
| 말·자막 읽기 | 로컬 무키/무로그인 직접 취득: M7lc 466구간, jN 6구간, 영어 원문·타임스탬프 확인 | Render에서는 watch 단계에서 YouTube 차단. 모바일 공통 자동 내용 답변 미완료 |
| 일반 스크립트 표시 경로 | 별도 probe의 기본 WEB `/next` 200, 실제 transcript continuation 발견 | `/get_transcript` 400 FAILED_PRECONDITION, 자막 반환 없음. 제품 대체 경로로 사용하지 않음 |
| 모바일 | 공통 서버 도구/반응형 HTML 구현 | 실제 모바일 앱 재생·전환·자막 질문·추천은 검증하지 못함 |

## 경계와 후속

- 영상/음성 파일 다운로드, 프록시, 로그인/챌린지/PO-token 우회, Gemini 연동은 하지 않았다.
- 직접 추출이 불가능하다는 뜻이 아니다. 같은 공개 영상 자막을 로컬 Mac에서 실제 읽었고, Render 발신 환경에서의 차단이 확인됐다. 자막 없는 영상 전체에 대한 성공 보장은 없다.
- Plugin directory에서 vidIQ의 YouTube transcript 기능을 발견해 선택 가능한 대안으로 제시했다. 설치/연결되지 않았고 실제 추출 기능·비용·제한을 테스트하지 않았다. 연결을 가정하거나 채팅/개인 데이터를 전달하지 않는다.
- 최신 MCP 카드에서 실제 전경 재생이 지속되는지 사용자 답변을 요청한 상태다. 모바일도 별도의 실기 증거가 필요하다.
- 목표는 미완료/활성이다. 테스트 통과나 검색 성공을 내용 답변·기기 전체 완료의 대체 증거로 쓰지 않는다.

실험 JSON·이미지는 저장소 밖 작업 폴더의 `production-assistant-evidence.json`, `production-caption-stage.json`, `production-player-observations.json`, `local-content-evidence.json`, `transcript-display-probe/`와 `outputs/`에 보존했다. 로컬에서 발견한 관련 없는 `server 2.js`는 수정·커밋하지 않았다.
