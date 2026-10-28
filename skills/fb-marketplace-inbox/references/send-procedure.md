# Send procedure (only after typed approval of the exact text)

1. Desktop Chrome (slot 4), `https://www.facebook.com/marketplace/inbox/`, Selling tab.
2. Click the thread row whose title is `<Buyer> · <Listing>` (match both). Re-read the thread: if the buyer
   sent something new since the draft, stop and re-confirm with the user.
3. Click the composer (`[role=textbox]`, placeholder "Aa" / "Write to <Buyer> · <Listing>"), type the approved
   text exactly, press Enter.
4. Verify a new `Message sent ... by You` / your bubble with that text appears. Unknown result → do not retry;
   tell the user.
5. Update `ledger.json`: state `sent`, `sent_at`, `sent_text`. Wait 20–60 s before the next send.
