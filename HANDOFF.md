# HANDOFF

更新：2026-10-11 · by Claude · HEAD `ffd07f7`
<!-- 規則見 AGENTS.md「Handoff」。上限 150 行；過期內容移到 docs/archive/HANDOFF-YYYY-MM.md。 -->

## ▶ 下一步（只放一件，必須帶 #Issue）
#496 讓 PR #502（realpath containment、push 目標 fail-closed、scope observer 涵蓋 `.git/` 與 ignored 檔）通過 Nexus Core issue gate 並落地——依據：最新活動（10/11）、`bug` 標籤、屬於檔案根逃逸的安全 invariant；同一個 PR 也涵蓋 #497、#498。

## 進行中
- #496、#497、#498 / PR #502：mergeable_state=clean，但「Nexus Core issue completion」「Nexus Core issue run」紅燈；#499 不在這個 PR 範圍內。
- #483 / PR #487：把 5 個沒被串進 npm test 的測試檔接上，檢查進行中（unstable）。
- #484 / PR #486：寫死的個人路徑改成依 HOME 推導；Smoke (macos-latest) 失敗。
- #488 / PR #489：把官方 Actions pin 到不可變的 SHA。
- #472 / PR #477：bound cutover 完成時釋放 state-root lease（P1）。
- #469 / PR #479：把 Nexus Core gate 重新 pin 到 9e387e9。
- #471 / PR #478：C4，從直接的 Dev MCP 操作中退役 Carrier governance。
- #330 / PR #480、#481：模型 attestation 未證實時 fail closed（兩個 PR 是同一個 head SHA）。

## 待確認（沒有 Issue 號）
- PR #480 與 #481 重複（同一個 SHA），應該留哪一個待決定。
- 9/20–10/06 還有不少舊 open PR（如 #144、#221、#285、#289、#290、#343、#363、#375、#412）長期無活動，是否關閉待 Owner 決定。

## 卡住 / 注意
- #499（download_artifact 的 host 只做前綴比對）還沒有修正 PR。
- 多個 PR 的 Nexus Core issue gate 紅燈；送出前要確認 issue 有 `NEXUS_CORE_EVIDENCE_UNIVERSE` marker，PR body 也帶 `NEXUS_CORE_ISSUE`。
- 本 repo 是 fork；gate 已拿掉 `fork==false` 條件（#457），不要再加回去。
