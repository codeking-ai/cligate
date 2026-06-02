export function createCancelAssistantRunToolDefinition({ handlers }) {
  return {
    name: 'cancel_assistant_run',
    description: [
      'Cancel another assistant run that is still alive in the same conversation.',
      '',
      'WHEN TO USE — only one situation: the conversation context contains <active_assistant_runs> with at least one entry whose status is queued / running / waiting_runtime / waiting_user, and the new user message tells you to stop, redirect, or replace what that run is doing. Typical triggers:',
      '  - User said "stop / cancel / never mind / 算了 / 别做了" → cancel and reply.',
      '  - User corrected a parameter mid-flight ("pick 64-bit instead", "install to D:\\foo not D:\\bar") → cancel the old run BEFORE you take over with the new parameters, otherwise two runs will fight over the same desktop / files.',
      '  - User asked for a fundamentally different task → cancel the old run first (unless the user explicitly asked for parallel execution).',
      '',
      'WHEN NOT TO USE: the user is only asking for status ("where are we" / "how long left") or chatting about something unrelated. In that case answer using the recentEvents summary from <active_assistant_runs>; do NOT cancel.',
      '',
      'NEVER cancel your own run. <active_assistant_runs> only lists OTHER runs — it does not contain the run you are executing in. There is no "duplicate of myself" to cancel; if you think there is, you are misreading the context. The system will reject a self-cancel with CANNOT_CANCEL_SELF.',
      '',
      'This call is idempotent: cancelling a run that already finished returns ok:true with alreadyTerminal:true and does nothing destructive. Pass the runId from <active_assistant_runs>[].id. Provide a short `reason` string (the user-visible motivation) so the cancellation event captures why.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: {
          type: 'string',
          description: 'The id of the assistant run to cancel, copied from <active_assistant_runs>[].id in the conversation context.'
        },
        reason: {
          type: 'string',
          description: 'A short human-readable reason for the cancellation (e.g. "user asked to switch to 64-bit installer", "user said 算了 to stop the install").'
        }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    // NOT mutating user data — this only flips an internal agent-run flag so
    // another run stops issuing tool calls. The user did not consent to a
    // confirmation prompt every time the supervisor decides to triage, so we
    // declare this side-effect as agent-internal and avoid the approval gate.
    mutating: false,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.cancelAssistantRun
  };
}

export default createCancelAssistantRunToolDefinition;
