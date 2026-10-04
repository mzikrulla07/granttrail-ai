# Demo walkthrough (≈ 8 minutes)

Start with `npm run dev` and open **http://localhost:5173**. To start from a clean
slate: stop the server, `npm run db:reset`, start again.

1. **Dashboard (Finance Director view)** — switch *Signed in as* to **Marcus Ellery —
   Finance Director**. Point out the five summary cards (Total, Due Soon, Overdue,
   Awaiting Review, Approved/Reported), the purple **DEMO MODE** banner, and that
   the Upload button is hidden: finance is read-only. Click the **Overdue** card —
   Maple Street Community Shelter is 26+ days past due.
2. Switch back to **Dana Whitfield — Grants Specialist**.
3. **Upload** — *Upload Agreement* → drag `samples/sample-02-lantern-house-bad-uei.pdf`
   onto the drop zone → *Upload and extract*. (Try a `.txt` file first to show the
   friendly rejection.)
4. **Review screen** — left: the agreement text with highlighted source excerpts
   (or *Original PDF*). Right: each field with confidence, excerpt and validation.
   The UEI is flagged **ERROR** ("a UEI never contains I or O") and **Approve is
   disabled**.
5. Click *Show in document* on the UEI to jump to the excerpt. Change the `I` to `J`.
   Validation re-runs instantly (deterministic rules, not AI); Approve enables.
6. *Save Draft* — the field shows "Edited by Dana Whitfield · AI extracted: …".
7. *Approve* — the confirmation dialog lists the final values and the warnings being
   acknowledged; tick the attestation and approve. The record locks.
8. *Export CSV* — open the file; then *Mark as reported* with a reference.
9. Scroll to **Record history**, then open **Audit Trail**: upload → extraction →
   validation → field edit (before/after) → approval → export → status change.
10. Show **Northgate Youth Housing Collaborative** (narrative agreement): several
    fields below 75% confidence are highlighted amber for verification.
11. Upload `sample-03-fairview-missing-fields.pdf`: missing UEI/amount show
    "No supporting text was found — human review required". Upload it again to show
    duplicate detection.
12. Switch to **Jordan Blake — Partner Agency** to show the future-role placeholder.

Talking point: **AI extracts. Code validates. Humans approve.** The model never
decides compliance; deterministic code does, and only a person can approve.
