'use strict';

// Who approves a request for approval, from facts only: the project's lead
// (the holder of its newest active grant) when that lead is a person other
// than the asker, else the first owner. One rule routes a new request, checks
// an answer when it is given, and says whose Needs you a waiting request is
// in, so a request moves with its lead. An AI lead's requests go to the first
// owner until a grant can say it may approve. Server-internal: the subject
// ids it returns never leave the host.
function createApproverRule(options) {
  if (!options || typeof options.leadOf !== 'function' || typeof options.firstOwner !== 'function') {
    throw new TypeError('approver rule: leadOf and firstOwner are required');
  }
  function approverFor(project, askerSubjectId, now) {
    const first = options.firstOwner();
    const owner = first ? Object.freeze({ subject_id: first.subject_id, name: first.name }) : null;
    let lead = null;
    try { lead = options.leadOf(project, now); } catch (_) { lead = null; }
    if (lead && lead.kind === 'person' && typeof lead.subject_id === 'string' && lead.subject_id !== askerSubjectId) {
      return Object.freeze({ approver: Object.freeze({ subject_id: lead.subject_id, name: lead.name }), owner });
    }
    return Object.freeze({ approver: owner, owner });
  }
  return Object.freeze(approverFor);
}

module.exports = Object.freeze({ createApproverRule });
