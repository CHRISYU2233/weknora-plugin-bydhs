# Incident Handling (sample)

> Sample document for testing WeKnora_plugin_byDHS. Everything here is fictional.

## Severity levels

| Severity | Definition | First response |
| --- | --- | --- |
| S1 | Service unavailable for all users | 15 minutes |
| S2 | Major function degraded | 1 hour |
| S3 | Minor function degraded | 1 business day |
| S4 | Cosmetic or documentation issue | next release |

## Roles

- **Incident commander** owns the timeline and communication.
- **Technical lead** owns diagnosis and mitigation.
- **Communicator** updates stakeholders every 30 minutes for S1 and S2.

## Process

1. Declare the incident in the incident channel with severity and impact.
2. Mitigate first, find the root cause second.
3. Write a postmortem within five business days for S1 and S2.
4. Postmortems list what happened, the impact, the timeline, the root cause and the
   follow-up actions with owners.

## Escalation

If an S1 is not mitigated within 30 minutes, escalate to the engineering director.
