# HL7 messages page

**HL7 messages** in the menu (administrators and integration engineers: needs `hl7.raw.view`).

| Tab | Shows |
|---|---|
| Received | Every message that came in: when, from which partner (source, reporting), type and control ID, the study it created or changed, and the result (processed, ignored, quarantined with the reason). |
| Sent to third party | Every assignment and cancellation sent: control ID, study, radiologist, delivery state, the ACK code and text, and each attempt. |
| Send a message | Paste or build an HL7 message and send it as one of the inbound partners (needs `hl7.send`). |

**View** opens one message, one segment per line; click a segment to see its numbered fields
(`PID-3`, `OBR-24`…). Every view is recorded in the audit log. A message whose content has been
archived says which archive file holds it.

## Sending a message by hand

1. Choose a starting point and click **Fill in**:
   - New order (ORM `NW`) from the source partner,
   - Cancel an order (ORM `CA`) for an accession,
   - Radiologist accepts / declines (ORC `OK` / `UA`), Preliminary / Final report (ORU `P` / `F`) for the
     study's current assignment, from the reporting partner.
2. Edit the text if you want (one segment per line is fine) and choose the partner.
3. **Send**. You get the same acknowledgment a partner would get. An accepted message is processed by
   the worker within seconds and appears on the Received tab.

It goes through exactly the same checks as a message from Mirth: allowed sending facilities, duplicate
and reused control IDs, partner role, then normal processing. Each send is audited (partner, control ID,
outcome), without the message content. Use test data only.

If an order goes to "needs a coordinator" with `NO_ELIGIBLE_RADIOLOGIST`, check that someone is on shift:
the demo shifts last 24 hours, so run `pnpm db:seed` again or add shifts on the Rota page.
