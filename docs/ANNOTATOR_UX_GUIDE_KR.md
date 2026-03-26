# ELASTIC Annotator UX 가이드 (작업자용)

이 문서는 **Human-in-the-loop 이벤트 검수 작업자**를 위한 실무 가이드입니다.
목표는 "현재 프레임에서 보이는 실제 경기 이벤트"와 "테이블 데이터"를 일치시키는 것입니다.

운영 주소(2026-03-26 기준): `http://3.225.19.210:8000`

- 홈: `http://3.225.19.210:8000/`
- 매치 진입(예시): `http://3.225.19.210:8000/annotate/m/J03WN1`
- 매치 진입(형식): `http://3.225.19.210:8000/annotate/m/{match_id}`

## 1. 홈(기본 페이지)에서 시작하기

기본 홈페이지(`http://3.225.19.210:8000/`) 기준으로 아래 순서로 시작합니다.

### 1.1 기존 세션이 이미 있는 경우

1. `Recent Sessions` 테이블에서 본인 작업 대상 경기를 찾습니다.
2. 같은 경기라도 여러 작업 탭이 있을 수 있으니 `Sheet Tab` 컬럼으로 본인 탭을 확인합니다.
3. 해당 행의 `Open Annotate` 링크(`http://3.225.19.210:8000/annotate/m/{match_id}`)로 진입합니다.
4. 진입 후 우측 상단 `Open Google Sheet` 버튼으로 시트 탭이 맞는지 최종 확인합니다.

### 1.2 기존 세션이 없는 경우(새로 시작)

1. 상단 `Session Setup` 카드에서 `Annotator Name` 입력
2. `Match` 선택
3. 필요 시 `Google Sheet (URL or ID)` 입력 후 `Save Sheet Mapping`
4. `Create Session` 클릭
5. 준비 완료 후 자동으로 annotate 화면으로 이동

## 2. annotate 화면 진입 후 시작 전 체크

1. 매치 링크로 접속합니다.  
   권장 링크 형식: `http://3.225.19.210:8000/annotate/m/{match_id}`
2. 좌측 상단 매치 ID가 맡은 경기인지 확인합니다.
3. 우측 상단 `Open Google Sheet` 버튼으로 대상 시트를 열어 둡니다.
4. `save` 상태가 `saved`인지 확인하고 작업을 시작합니다.

## 3. 화면 구성 이해

## 3.1 상단 헤더

- `Open Google Sheet`: 현재 세션과 연결된 시트 열기
- `Sync Sheet`: 현재 화면의 이벤트 데이터를 시트로 즉시 재동기화
- `Reset Timeline (Initial)`: Event Timeline과 시트를 초기 상태로 복원

## 3.2 왼쪽 비디오 패널

- 현재 재생 시점의 `absolute frame`을 크게 표시합니다.
- 조작 키:
  - `Space`: 재생/정지
  - `← / →`: 0.2초 이동
  - `Shift + ← / →`: 1프레임 이동

## 3.3 오른쪽 Event Timeline

- 행 클릭 시 해당 이벤트 프레임으로 점프합니다.
- 현재 프레임과 선택 프레임 차이(Δ)로 정합성을 빠르게 확인합니다.

## 3.4 Edit 패널

- 선택한 행의 필드를 수정합니다.
- `Confirm Row Changes`를 눌러야 해당 행 수정이 실제 데이터에 반영됩니다.
- 행 수정 시 `error_type`은 필수입니다.

## 4. 1개 이벤트 검수 표준 루틴

1. 비디오를 멈추고 현재 장면을 확인합니다.
2. Timeline에서 해당 이벤트 행을 선택합니다.
3. `spadl_type`, `player_id`, `receiver_id`, `synced_frame_id`, `receive_frame_id`, `outcome` 등을 수정합니다.
4. 수정 원인에 맞게 `error_type`을 선택합니다.
5. `Confirm Row Changes`를 누릅니다.
6. 상단 `save` 상태가 `saving -> saved`로 바뀌는지 확인합니다.

## 5. 자동 저장/동기화 동작

- `Confirm Row Changes` 후에는 자동 저장이 실행됩니다.
- 자동 저장 API는 시트 동기화까지 함께 수행합니다.
- 즉, 일반 작업에서는 Confirm만 해도 시트 반영이 됩니다.
- `Sync Sheet`는 수동 재동기화 버튼입니다.  
  (외부에서 시트를 건드렸거나 반영 상태가 의심될 때 사용)

## 6. 필드 입력 규칙

- `player_id`, `receiver_id`
  - 기본은 `home_번호`, `away_번호` 형식
  - 예외적으로 기존 데이터에 이미 있던 특수 토큰(예: `out_bottom`)은 선택 가능
- `error_type`
  - 대표 오분류 항목: `spadl_type`, `player_id`, `receiver_id`, `synced_ts`, `receive_ts`, `outcome`
  - 누락 이벤트는 `missing`, 불필요 이벤트는 `false_positive`

## 7. 품질 체크리스트 (작업 종료 전)

1. pass-like 이벤트의 `receive_ts`가 비어 있지 않은지 확인
2. 프레임 점프 시 이벤트 타이밍이 실제 장면과 맞는지 샘플 재검수
3. Validation warnings가 남아 있으면 프레임 단위로 확인
4. 최종적으로 `Sync Sheet` 1회 실행 후 시트 반영 확인

## 8. 자주 막히는 상황

## 8.1 Confirm 버튼이 비활성/실패

- `error_type` 미선택일 가능성이 큽니다.
- `player_id`/`receiver_id` 형식이 허용 규칙에 맞지 않을 수 있습니다.

## 8.2 스페이스바가 안 먹힘

- 입력창(input/select/textarea)에 포커스가 있으면 전역 단축키가 막힙니다.
- 편집창 바깥을 클릭하고 다시 시도합니다.

## 8.3 어떤 행이 맞는지 헷갈림

- Timeline에서 행을 클릭해 비디오를 점프시키고,
- 좌측 `absolute frame`과 우측 선택 행 프레임을 Δ 값으로 비교하세요.

## 9. 운영 권장 방식 (여러 작업자)

1. 작업자는 Session Setup에서 본인 이름으로 세션 생성
2. 같은 매치를 여러 명이 볼 때도 매치 링크는 `http://3.225.19.210:8000/annotate/m/{match_id}`로 통일
3. 시트 탭/변경 이력 기준으로 작업자별 검수 결과를 비교
