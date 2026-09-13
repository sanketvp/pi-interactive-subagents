No `subagent` or inspection tools are available, so I cannot dispatch this review or run tests. I’ll review the supplied text inline; omitted v1.1 sections and the original round-3 findings cannot be independently checked.
The dispositions are not all resolved. Several fixes are explicit—plan quorum minimum, truncation fail-closed, request-wide T1, abandoned-request visibility, accepted profile copies, and queued-slot accounting—but the sandbox and state-machine changes introduce blockers. No tests were run.

1. **v1.2 is not a standalone implementation contract.**  
   Despite “supersedes … in full,” schemas, validation, snapshot construction, verification discovery, retries, and tests repeatedly defer to unavailable v1.1 text. Original round-3 findings are also absent; the disposition table cannot independently establish that each finding was resolved.  
   **Correction:** Include the inherited normative sections and complete adversarial cases, plus the original findings or immutable references supplied with the review packet.

2. **The sandbox denies access to its own verification tree (§8.3–8.4).**  
   `<dir>` is under `<sessionDir>`, which receives `deny file*`. The subsequent exception allows only `file-write*`, not reading test files, dependencies, or directory contents. The private temporary directory has the same problem if placed under the session directory. The blanket session-denial assertion and intended verification access conflict.  
   **Correction:** Define explicit read/write exceptions for the isolated tree and private temporary directory, or place them outside the denied session subtree. Test a successful real verification command as well as denied sibling access.

3. **An allow-default profile does not establish the claimed process boundary (A10, §8.4).**  
   Blocking process inspection, signals, selected sockets, and filesystem writes does not block Mach/XPC services or other IPC brokers that can perform operations or launch processes outside sandbox inheritance. Coordinator/author network access also leaves paths to local execution services. These are bypass classes, not the accepted prompt-injection residual.  
   **Correction:** Specify broker/IPC restrictions and permissible network endpoints, preferably using an allowlisted profile. Add working unsandboxed controls for launch-service and local-helper execution; require sandboxed attempts to fail without causing outside writes or trusted TUI actions.

4. **Protected-path precedence and inherited capabilities are unspecified (§8.4).**  
   Write exceptions can overlap protected paths when a registered repository or configured cache contains session, policy, socket, or harness files. Only cache placement under `~/.pi` is explicitly forbidden. Canonicalisation, symlink aliases, SBPL string escaping, and inherited file descriptors are unspecified. Path restrictions cannot be assumed to revoke already-open descriptors.  
   **Correction:** Validate canonical roots and protected overlaps, escape profile literals, explicitly protect harness executables, and close all nonessential inherited descriptors. Test overlapping roots, aliases, adversarial path names, and inherited socket/file descriptors. Do not rely on the unsupported blanket statement that SBPL is “last matching rule wins.”

5. **The sandbox self-test can certify a non-working attack probe (§8.4).**  
   `curl http://127.0.0.1:1/` normally fails without a sandbox because no server is listening. Missing utilities, invalid `sysctl` syntax, and inaccessible fixtures likewise produce false security successes. The later adversarial controls do not make the runtime self-test sound.  
   **Correction:** Use harness-owned readable/writable canaries and live TCP/Unix listeners. Require each identical unsandboxed probe to succeed before its sandboxed failure counts. Probe setup failure must mark sandbox availability false. Test every generated profile’s permitted operations too.

6. **Socket lifetime does not eliminate PID-reuse races (§8.5).**  
   Holding a connection open does not pin the originating process: a descendant can inherit the descriptor while the original peer exits. A later `ps` snapshot can observe reused PIDs or changed ancestry. Pane membership also authenticates a process subtree, not specifically the trusted worker receipt producer.  
   **Correction:** Specify process-instance identity checks, including process birth identity and launch-instance association, and restrict accepted producers to registered trusted worker processes. Validate peer-credential semantics on supported macOS versions. Test descriptor inheritance, original-peer exit, PID reuse, pane replacement, and unregistered same-pane descendants.

7. **Non-shell tools still provide unsandboxed write paths (G8/G12).**  
   A git-root check is not a security boundary. A protected session or policy path can itself be inside a registered git repository. Parent-symlink replacement can also redirect an unsandboxed `write`/`edit` after validation. Thus “every shell is sandboxed” does not establish that the model cannot modify registry, policy, receipt machinery, or harness code.  
   **Correction:** Apply immutable protected-path exclusions to all write-capable tools and use race-resistant target resolution/opening. Enumerate and bound every enabled custom tool. Add direct-tool attacks against protected paths and symlink-swap tests.

8. **G12 prevents the specified planner/researcher output workflow (§2, §4.2, §6).**  
   Those authors must write under `<sessionDir>/artifacts/<req>/`, but G12 refuses worker writes outside git roots. Their shell sandbox also denies the session directory. G8’s coordinator exception does not fix worker output.  
   **Correction:** Add a role-specific, exact assigned-artifact capability through the worker write handler, excluding all sibling session paths. Test successful plan/research creation and denied sibling writes.

9. **Early verification evidence is stored but not necessarily acted upon (§5.1–5.2).**  
   A FAIL arriving in DRAFT or QUEUED is recorded, but there is no repair effect. If review later approves, settlement checks clearance without explicitly dispatching that stored failure. ERROR/INVALID/NO_COMMANDS received before approval similarly lack a guaranteed ladder transition. Even REVIEWING FAIL says “after settlement” without defining persisted deferred work.  
   **Correction:** At every relevant transition, derive required verification actions from current evidence, with idempotent repair/retry/prompt effects. Extend the verifier-first trace to FAIL, ERROR, INVALID, and NO_COMMANDS—not just PASS—and assert eventual action.

10. **Cancellation refunds can debit rounds that were never charged (§5.1–5.2).**  
    The global rule refunds “every quorum CANCELLED,” while `USER_WAIVE` applies in DRAFT/REVISE/BLOCKED and unconditionally says `CANCELLED`. The unattributed-write row also cancels from states without an active quorum. Implementations can decrement below zero or refund a completed round.  
    **Correction:** Refund only an existing, unsettled, charged quorum, exactly once. Waiving without an active quorum must not cancel or refund anything. Add DRAFT waiver, settled-REVISE waiver, unattributed DRAFT write, and duplicate-cancellation traces.

11. **Background-writer attribution still contradicts its regression test (§4.3, #38).**  
    After the Anthropic shell launch window closes, a later background delta can occur in a window with no write-capable coordinator call. Rule 3 adds `external ∪ coordinatorShellTaint`, which contains Anthropic, not necessarily the subsequently observed OpenAI family. If another author is live, rule 1 can attribute that background delta only to the unrelated author; taint is applied only in rule 3.  
    **Correction:** Define persistent outstanding shell-write authority and conservatively union its contributor families into every potentially affected delta, regardless of other live writers. Specify how coordinator model changes affect that authority. Test multiple snapshot boundaries and an unrelated concurrent author.

Repo: `pi-interactive-subagents` (uninspected) · Session UUID: unavailable · Model: unavailable

VERDICT: REVISE
