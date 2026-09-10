# Maataa landing validation — 2026-09-10

- Production build passed with `.next-maataa-final`.
- Existing regression suite: 16 suites / 119 tests passed.
- Focused Maataa suite: 5 tests passed (persistence, turn concurrency, failure retention, publication, query validation, loopback endpoints, chat contract and remote-model rejection).
- Playwright used actual local `maataa:latest`: saved a conversation, received a real reply, generated a structured district query, opened its review form, saved a journal draft, published locally, reloaded and reopened the source conversation.
- Desktop 1440px and mobile 390px screenshots captured. No page errors or mobile horizontal overflow in this flow.
- Public Host and foreign Origin rejected with 403; missing-model prompt retained as failed.
- Validation used `/tmp/brahmini-maataa-smoke/conversations.db`, not operator conversation data.
- Query saving uses the existing Query Studio method API. This browser flow reviewed the generated draft but did not save a method into the operator collection database or execute Google Maps collection.
- Model inventory verified three installed models. Load/unload controls implemented; model residency controls were not separately browser-tested.
- Published milestones are user-authored local records, not external publication or independent completion verification.
