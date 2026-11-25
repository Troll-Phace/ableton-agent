---
name: deep-audit
description: "Run an explicitly requested bounded audit of a named scope or the full project."
---

# Deep Audit

Use the user's explicit scope; if absent, clarify the scope before starting the audit. Read the relevant architecture and phase criteria. Delegate a bounded independent review where useful. Verify candidate findings with a reproduction or concrete code-path evidence; list unresolved suspicions separately.

One review pass, one scoped fix round if fixes are authorized, and one report. Regression-test fixes without recursively auditing the audit. Mutation testing, fuzzing, and long soaks require a scope that calls for them.

Report findings with impact, location, verified-how, fixed/filed/pending disposition, and what was not covered.
