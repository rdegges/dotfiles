---
name: navia-fsa-claims
description: Submit user-provided health care FSA receipts to Navia Benefit Solutions in the user's signed-in Chrome session. Use for Navia claim preparation, receipt upload, and submission; do not use for other FSA providers.
---

# Navia FSA claims

Use the user's current request and supplied documents as the authority for each claim. A request to submit a receipt to Navia authorizes entering its claim details and uploading that receipt to Navia. The user's global browser rules grant a standing exception for the final **Send claim to Navia** once the details match the source documents (the Navia exception in the global Browser rules); every other confirmation rule still applies. This skill grants no exception of its own: if Navia requires an agreement checkbox, ask the user to confirm that they have read and agree to those terms at action time before checking it.

## Prepare the evidence

1. Read every page of each supplied PDF or image. Inspect rendered PDF pages as well as extracted text: bills embedded as photos may have no extractable text.
2. Identify the patient, service date, provider, service description, and out-of-pocket amount from the bill or EOB. Treat a payment date as a payment date, never as the service date. Use the bill's patient and provider labels to distinguish a clinician's name from the patient's name.
3. Use documentation that shows the service date, description, and cost. A payment confirmation alone does not substantiate a Navia claim. If a required fact or supporting document is missing or conflicts, ask the user for that specific item before completing the claim.

## Submit in Navia

1. Use the signed-in Navia tab in the user's Chrome session. Follow the current Chrome control skill and its browser safety instructions. Do not switch to a different browser to bypass sign-in or site problems. If Navia shows a login, MFA, or session-expired page, stop and ask the user to sign in in that tab, then continue. Never type credentials or MFA codes.
2. Review the relevant Health Care FSA account statement for a matching service date, patient, provider, and amount. Stop and ask if a likely duplicate exists.
3. Open **Submit a Claim → Add item to claim**. Select **Health Care FSA** and the plan year that covers the service date. Upload the supplied evidence and wait until Navia lists the file as uploaded; a temporary “loading” status is not proof of completion.
4. Enter the closest supported service category, service start and end dates, provider, patient, and out-of-pocket amount. For a one-day visit, use that date in both date fields. Add a short factual comment only when it clarifies the bill.
5. Select **I'm finished** and check the resulting claim item against the source document. Do not invent missing data or use a prior claim's values for a new visit.
6. If Navia requires “I have read and agree” to terms, obtain the user's action-time confirmation before checking it. Then select **Send claim to Navia** without a separate draft-review pause, under the Navia exception in the global Browser rules, unless the current request asks for one.
7. Verify Navia's **Success! Claim Submitted** receipt. If the success page does not appear after Send (error, timeout, blank page), do not resubmit. Check the claims list or account statement for the claim first, and ask the user before any second attempt. Report the claim amount, service date, patient, and any stated review timeline. Say “submitted,” not “approved,” until Navia actually approves it. Save a screenshot of the receipt when the browser guidance calls for proof of work. The receipt contains health data. Keep any screenshot in the session scratch directory only. Never commit it, put it in the vault, or attach it anywhere else.

Stop before submission if Navia shows an unexpected amount, patient, plan year, duplicate, or other material discrepancy. Do not complete surveys or unrelated account actions.
